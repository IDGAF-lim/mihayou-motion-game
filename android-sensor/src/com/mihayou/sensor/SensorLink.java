package com.mihayou.sensor;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.function.DoubleSupplier;
import org.json.JSONObject;

public final class SensorLink implements AutoCloseable {
    public interface Listener {
        void state(boolean ready, String text, double rttMs);
        void action(String text);
    }
    private final Listener listener;
    private final DoubleSupplier clock;
    private final String clientId, label;
    private final ScheduledExecutorService probes = Executors.newSingleThreadScheduledExecutor();
    private final ThreadPoolExecutor sender = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<Runnable>(2));
    private volatile boolean active, socketReady, socketConnecting, syncReady;
    private volatile int generation;
    private volatile String base = "", endpoint = "", runId = "";
    private volatile SimpleWebSocket socket;
    private volatile HttpURLConnection request;
    private volatile double lastRtt;
    private ScheduledFuture<?> ticker;
    public SensorLink(String clientId, String label, DoubleSupplier clock, Listener listener) {
        this.clientId = clientId; this.label = label; this.clock = clock; this.listener = listener;
    }
    public synchronized void connect(String address) throws Exception {
        URI uri = new URI(address.trim());
        if (!"ws".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
            uri.getQuery() != null || uri.getFragment() != null)
            throw new IllegalArgumentException("请填写 ws://电脑IP:端口/sensor");
        disconnect();
        endpoint = new URI("ws", null, uri.getHost(), uri.getPort(), "/sensor", null, null).toString();
        base = new URI("http", null, uri.getHost(), uri.getPort(), null, null, null).toString();
        active = true;
        final int g = generation;
        listener.state(false, "正在连接并同步", Double.NaN);
        ticker = probes.scheduleWithFixedDelay(() -> probe(g), 0, 1, TimeUnit.SECONDS);
    }
    private boolean current(int g) { return active && generation == g; }
    private JSONObject identity() throws Exception {
        return new JSONObject().put("clientId", clientId).put("label", label);
    }
    private void probe(int g) {
        if (!current(g)) return;
        try {
            if (!socketReady && !socketConnecting) {
                SimpleWebSocket old = socket;
                if (old != null) old.close();
                socketConnecting = true;
                final SimpleWebSocket[] owner = new SimpleWebSocket[1];
                final SimpleWebSocket next = new SimpleWebSocket(endpoint, new SimpleWebSocket.Listener() {
                    public void opened() {
                        if (!current(g) || socket != owner[0]) return;
                        socketConnecting = false; socketReady = true;
                        listener.state(syncReady, syncReady ? "已连接 · 已同步" : "已连接 · 同步中", lastRtt);
                    }
                    public void failed(String message) {
                        if (!current(g) || socket != owner[0]) return;
                        socketConnecting = false; socketReady = false;
                        listener.state(false, "连接失败，自动重试", Double.NaN);
                    }
                });
                owner[0] = next; socket = next; next.connect();
            }
            double c0 = clock.getAsDouble();
            JSONObject answer = post("/api/sync", identity().put("c0", c0), g);
            double c3 = clock.getAsDouble();
            JSONObject accepted = post("/api/measurement",
                identity().put("sampleId", answer.getString("sampleId")).put("c3", c3), g);
            if (!current(g)) return;
            runId = accepted.getString("runId"); lastRtt = accepted.getDouble("rttMs"); syncReady = true;
            listener.state(socketReady, socketReady ? "已连接 · 每秒测量" : "WebSocket重连中", lastRtt);
        } catch (Exception error) {
            if (!current(g)) return;
            syncReady = false;
            SimpleWebSocket old = socket; socketReady = false; socketConnecting = false;
            if (old != null) old.close();
            listener.state(false, "连接失败，自动重试", Double.NaN);
        }
    }
    private JSONObject post(String route, JSONObject body, int g) throws Exception {
        if (!current(g)) throw new InterruptedException();
        HttpURLConnection connection = (HttpURLConnection) new URL(base + route).openConnection();
        request = connection;
        try {
            connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setConnectTimeout(1500); connection.setReadTimeout(1500);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(data); }
            if (connection.getResponseCode() != 200) throw new java.io.IOException("服务未接受同步");
            ByteArrayOutputStream collected = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[1024]; int length;
                while ((length = input.read(buffer)) >= 0) {
                    if (collected.size() + length > 65536) throw new java.io.IOException("响应过长");
                    collected.write(buffer, 0, length);
                }
            }
            if (!current(g)) throw new InterruptedException();
            return new JSONObject(collected.toString("UTF-8"));
        } finally { connection.disconnect(); if (request == connection) request = null; }
    }
    public void send(String sessionId, long sequence, String action, double sensorTimeMs, boolean isTest) {
        final int g = generation;
        final String capturedRun = runId;
        final SimpleWebSocket capturedSocket = socket;
        if (!current(g) || !syncReady || !socketReady) { listener.action("未连接：本次动作未发送"); return; }
        try {
            sender.execute(() -> {
                if (!current(g) || !socketReady || !syncReady || socket != capturedSocket ||
                    !capturedRun.equals(runId) || clock.getAsDouble() - sensorTimeMs > 400) {
                    listener.action("动作已过期或连接已变更，未补发"); return;
                }
                try {
                    JSONObject event = identity().put("type", "action").put("sessionId", sessionId)
                        .put("sequence", sequence).put("action", action).put("sensorTimeMs", sensorTimeMs)
                        .put("runId", capturedRun).put("isTest", isTest);
                    capturedSocket.sendText(event.toString());
                    if (current(g)) listener.action("事件 #" + sequence + " 已发出");
                } catch (Exception error) {
                    if (!current(g)) return;
                    socketReady = false; socketConnecting = false; syncReady = false; capturedSocket.close();
                    listener.state(false, "动作发送失败，自动重连；本次不补发", Double.NaN);
                }
            });
        } catch (RejectedExecutionException error) { listener.action("发送繁忙：本次动作已丢弃"); }
    }
    public synchronized void disconnect() {
        active = false; generation++; socketReady = false; socketConnecting = false; syncReady = false; runId = "";
        if (ticker != null) ticker.cancel(false);
        sender.getQueue().clear();
        SimpleWebSocket old = socket; socket = null; if (old != null) old.close();
        HttpURLConnection oldRequest = request; if (oldRequest != null) oldRequest.disconnect();
    }
    public void close() { disconnect(); probes.shutdownNow(); sender.shutdownNow(); }
}
