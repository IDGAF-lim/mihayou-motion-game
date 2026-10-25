package com.mihayou.linktest;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.graphics.Color;
import android.view.WindowManager;
import android.widget.*;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends Activity implements SensorEventListener {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final String sessionId = UUID.randomUUID().toString();
    private EditText address;
    private TextView status, rttLabel, result, sensorStatus, sensorInfo, signal, thresholdLabel;
    private Button connect, up, down, batch, calibrate, detect, rearm;
    private SeekBar sensitivity;
    private volatile boolean running = false;
    private volatile boolean syncReady = false;
    private volatile int generation = 0;
    private volatile String baseUrl = "", runId = "";
    private String clientId;
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicInteger pendingActions = new AtomicInteger();
    private boolean batchRunning = false;
    private volatile HttpURLConnection activeRequest;
    private SensorManager sensors;
    private Sensor linearSensor, accelerometer;
    private SwingDetector detector;
    private boolean detecting = false, gravityReady = false;
    private long gravityTimestamp;
    private final float[] gravity = new float[3];
    private final double[] zeroSum = new double[3], zeroBias = new double[3];
    private int zeroCount, upCount, downCount;
    private long zeroStart = -1, lastSignal;
    private boolean zeroReady, calibrationSaved;
    private static final String CAL_X = "swingAxisX", CAL_Y = "swingAxisY", CAL_Z = "swingAxisZ";
    private static final String CAL_THRESHOLD = "swingThreshold", CAL_PEAK = "swingCalibrationPeak";
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            if (!running || batchRunning) return;
            final int g = generation;
            network.execute(() -> {
                try {
                    double value = sync(g);
                    handler.post(() -> {
                        if (g != generation || !running) return;
                        rttLabel.setText(String.format(java.util.Locale.US, "%.1f ms", value));
                        status.setText("已连接 · 每秒测量");
                        status.setTextColor(Color.rgb(21,115,75));
                        syncReady = true;
                        setActions(true);
                    });
                } catch (Exception e) { failure(g, e); }
                if (g == generation && running) handler.postDelayed(ticker, 1000);
            });
        }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        clientId = getPreferences(0).getString("clientId", "");
        if (clientId.isEmpty()) {
            clientId = UUID.randomUUID().toString();
            getPreferences(0).edit().putString("clientId", clientId).apply();
        }
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(42), dp(24), dp(28));
        content.setBackgroundColor(Color.rgb(245,247,245));
        scroll.addView(content);
        TextView title = text("咪哈友", 28, true);
        content.addView(title);
        content.addView(text("体感控制与延迟测试 · v1.1", 18, true));
        content.addView(text("电脑地址", 14, false), margin(22));
        address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("http://电脑IP:端口");
        address.setText(getPreferences(0).getString("address", ""));
        content.addView(address, new LinearLayout.LayoutParams(-1, dp(56)));
        connect = button("连接并测量");
        content.addView(connect, margin(8));
        status = text("未连接", 14, false);
        content.addView(status, margin(12));
        content.addView(text("手机请求往返 RTT", 14, false), margin(22));
        rttLabel = text("—", 38, true);
        rttLabel.setTextColor(Color.rgb(21,115,75));
        content.addView(rttLabel);
        content.addView(text("体感识别", 19, true), margin(28));
        sensorInfo = text("动作阈值由首次校准动作自动估计", 12, false);
        content.addView(sensorInfo, margin(4));
        calibrate = button("校准上挥方向");
        content.addView(calibrate, margin(12));
        detect = button("开始体感识别");
        content.addView(detect, margin(8));
        sensorStatus = text("先连接电脑，再校准并开始识别", 14, false);
        content.addView(sensorStatus, margin(8));
        signal = text("上挥 0 · 下挥 0", 13, false);
        content.addView(signal, margin(4));
        rearm = button("已回正，重新就绪");
        content.addView(rearm, margin(8));
        thresholdLabel = text("动作阈值 3.2 m/s²", 13, false);
        content.addView(thresholdLabel, margin(12));
        sensitivity = new SeekBar(this);
        sensitivity.setMax(30);
        sensitivity.setProgress(6);
        content.addView(sensitivity, new LinearLayout.LayoutParams(-1, dp(48)));
        LinearLayout diagnostics = new LinearLayout(this);
        up = button("上挥测试");
        down = button("下挥测试");
        diagnostics.addView(up, new LinearLayout.LayoutParams(0, dp(56), 1));
        LinearLayout.LayoutParams downParams = new LinearLayout.LayoutParams(0, dp(56), 1);
        downParams.leftMargin = dp(10);
        diagnostics.addView(down, downParams);
        content.addView(text("手动通信对照", 14, true), margin(20));
        content.addView(diagnostics, margin(4));
        batch = button("发送 100 个编号事件");
        content.addView(batch, margin(10));
        result = text("等待测试", 15, false);
        content.addView(result, margin(12));
        setContentView(scroll);
        if (Build.VERSION.SDK_INT >= 30) {
            content.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(
                    android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
                view.setPadding(dp(24) + bars.left, dp(16) + bars.top,
                    dp(24) + bars.right, dp(20) + bars.bottom);
                return insets;
            });
        }
        setActions(false);
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        linearSensor = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        detector = new SwingDetector(new SwingDetector.Listener() {
            @Override public void onState(String value) {
                handler.post(() -> {
                    if (!detecting) return;
                    sensorStatus.setText(zeroReady ? value : "静止基线采集中");
                    sensorStatus.setTextColor(value.contains("上挥") || value.contains("下挥")
                        ? Color.rgb(21,115,75) : Color.rgb(35,48,40));
                    if (detector.isCalibrated() && !calibrationSaved) saveCalibration();
                });
            }
            @Override public void onAction(String action, double sensorTimeMs, double peak) {
                if ("swing_up".equals(action)) upCount++; else downCount++;
                result.setText(("swing_up".equals(action) ? "识别到上挥" : "识别到下挥") +
                    " · 已确认峰值 " + String.format(java.util.Locale.US, "%.1f m/s²", peak));
                oneAction(action, sensorTimeMs, false);
            }
        });
        loadCalibration();
        updateSensorInfo();
        calibrate.setEnabled(linearSensor != null || accelerometer != null);
        detect.setEnabled(linearSensor != null || accelerometer != null);
        connect.setOnClickListener(v -> { if (running) stop(); else start(); });
        up.setOnClickListener(v -> oneAction("swing_up", now(), true));
        down.setOnClickListener(v -> oneAction("swing_down", now(), true));
        batch.setOnClickListener(v -> runBatch());
        calibrate.setOnClickListener(v -> {
            if (batchRunning) return;
            if (!detecting) startDetection();
            if (!detecting) return;
            getPreferences(0).edit().remove(CAL_X).remove(CAL_Y).remove(CAL_Z)
                .remove(CAL_THRESHOLD).remove(CAL_PEAK).apply();
            calibrationSaved = false;
            resetBaseline();
            detector.beginCalibration();
        });
        detect.setOnClickListener(v -> { if (detecting) stopDetection(); else startDetection(); });
        rearm.setOnClickListener(v -> {
            if (!detecting || !detector.isCalibrated()) return;
            detector.resetForStart();
            resetBaseline();
        });
        sensitivity.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser) {
                    detector.setThreshold(2.0 + progress * 0.2);
                    thresholdLabel.setText(String.format(java.util.Locale.US,
                        "动作阈值 %.1f m/s²", detector.getThreshold()));
                }
            }
            public void onStartTrackingTouch(SeekBar bar) {}
            public void onStopTrackingTouch(SeekBar bar) { saveCalibration(); }
        });
        setActions(false);
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout.LayoutParams margin(int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
        p.topMargin = dp(top); return p;
    }
    private TextView text(String value, int size, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(35,48,40));
        view.setPadding(0, dp(4), 0, dp(4));
        if (bold) view.setTypeface(null, android.graphics.Typeface.BOLD);
        return view;
    }
    private Button button(String label) {
        Button value = new Button(this);
        value.setText(label); value.setAllCaps(false);
        value.setMinHeight(dp(48)); return value;
    }
    private void setActions(boolean enabled) {
        up.setEnabled(enabled && !batchRunning);
        down.setEnabled(enabled && !batchRunning);
        batch.setEnabled(enabled && !batchRunning);
        if (detect != null) detect.setEnabled(enabled && !batchRunning && (linearSensor != null || accelerometer != null));
        if (calibrate != null) calibrate.setEnabled(enabled && !batchRunning && (linearSensor != null || accelerometer != null));
        if (rearm != null) rearm.setEnabled(enabled && !batchRunning);
    }
    private void start() {
        try {
            String value = address.getText().toString().trim();
            if (!value.contains("://")) value = "http://" + value;
            URI uri = URI.create(value);
            if (!"http".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null)
                throw new Exception("请填写 http://电脑IP:端口");
            baseUrl = "http://" + uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "");
        } catch (Exception e) { status.setText("地址无效，请按电脑页面填写"); return; }
        getPreferences(0).edit().putString("address", baseUrl).apply();
        runId = ""; syncReady = false; generation++; running = true;
        address.setEnabled(false); connect.setText("停止连接");
        status.setText("正在连接");
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        handler.removeCallbacks(ticker); handler.post(ticker);
    }
    private void stop() {
        running = false; syncReady = false; generation++;
        stopDetection();
        handler.removeCallbacks(ticker);
        HttpURLConnection request = activeRequest;
        if (request != null) request.disconnect();
        address.setEnabled(true); connect.setText("连接并测量");
        status.setText("已停止"); setActions(false);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private static double now() { return SystemClock.elapsedRealtimeNanos() / 1000000.0; }
    private JSONObject request(String route, JSONObject body, int g) throws Exception {
        if (!running || g != generation) throw new InterruptedException();
        HttpURLConnection c = (HttpURLConnection) new URL(baseUrl + route).openConnection();
        activeRequest = c;
        try {
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setConnectTimeout(2500); c.setReadTimeout(2500);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            int code = c.getResponseCode();
            ByteArrayOutputStream collected = new ByteArrayOutputStream();
            InputStream stream = code < 400 ? c.getInputStream() : c.getErrorStream();
            if (stream != null) try (InputStream in = stream) {
                byte[] buffer = new byte[2048]; int read;
                while ((read = in.read(buffer)) != -1) {
                    if (collected.size() > 65536) throw new IOException("响应过长");
                    collected.write(buffer, 0, read);
                }
            }
            if (code >= 400) throw new IOException("HTTP " + code);
            return new JSONObject(collected.toString("UTF-8"));
        } finally { c.disconnect(); activeRequest = null; }
    }
    private JSONObject identity() throws Exception {
        return new JSONObject().put("clientId", clientId).put("label", Build.MANUFACTURER + " " + Build.MODEL);
    }
    private double sync(int g) throws Exception {
        // Four monotonic timestamps; phone and server origins are never directly subtracted.
        JSONObject first = identity();
        double c0 = now();
        first.put("c0", c0);
        JSONObject answer = request("/api/sync", first, g);
        double c3 = now();
        JSONObject report = identity().put("sampleId", answer.getString("sampleId")).put("c3", c3);
        JSONObject accepted = request("/api/measurement", report, g);
        if (g != generation || !running) throw new InterruptedException();
        runId = accepted.getString("runId");
        return accepted.getDouble("rttMs");
    }
    private JSONObject action(String name, String batchId, String currentRun, double sourceTime) throws Exception {
        JSONObject value = identity().put("sessionId", sessionId).put("sequence", sequence.incrementAndGet())
            .put("type", "action").put("action", name).put("sensorTimeMs", sourceTime)
            .put("runId", currentRun).put("isTest", !batchId.isEmpty());
        if (!batchId.isEmpty()) value.put("batchId", batchId);
        return value;
    }
    private void oneAction(String name, double sourceTime, boolean isTest) {
        if (!syncReady || batchRunning) {
            result.setText("电脑未连接：本次动作仅本地识别，未发送");
            return;
        }
        if (pendingActions.incrementAndGet() > 2) {
            pendingActions.decrementAndGet();
            result.setText("发送繁忙：已丢弃本次动作，未补发");
            return;
        }
        final int g = generation;
        final String capturedRun = runId;
        network.execute(() -> {
            try {
                if (!running || g != generation || !capturedRun.equals(runId) || now() - sourceTime > 400) {
                    handler.post(() -> { if (g == generation) result.setText("动作已过期，未补发"); });
                    return;
                }
                JSONObject event = action(name, isTest ? UUID.randomUUID().toString() : "", capturedRun, sourceTime);
                long eventSequence = event.getLong("sequence");
                JSONObject answer = request("/api/action", event, g);
                handler.post(() -> {
                    if (g == generation) result.setText("事件 #" + eventSequence + " · " +
                        ("accepted".equals(answer.optString("status")) ? "电脑已接收" : answer.optString("status")));
                });
            } catch (Exception e) { failure(g, e); }
            finally { pendingActions.decrementAndGet(); }
        });
    }
    private void runBatch() {
        if (!running || batchRunning) return;
        stopDetection();
        batchRunning = true; setActions(false); handler.removeCallbacks(ticker);
        final int g = generation;
        result.setText("编号测试 0 / 100");
        network.execute(() -> {
            int sent = 0, ack = 0, rejected = 0;
            String batchId = UUID.randomUUID().toString(), capturedRun = runId;
            try {
                for (int i = 0; i < 100 && running && g == generation; i++) {
                    sent++;
                    JSONObject answer = request("/api/action", action(i % 2 == 0 ? "swing_up" : "swing_down", batchId, capturedRun, now()), g);
                    if ("accepted".equals(answer.optString("status"))) ack++; else rejected++;
                    final int done = sent;
                    handler.post(() -> { if (g == generation) result.setText("编号测试 " + done + " / 100"); });
                    if (i % 10 == 9) Thread.sleep(30);
                }
                final String summary = "尝试 " + sent + " · 确认接收 " + ack + " · 拦截 " + rejected;
                handler.post(() -> { if (g == generation) result.setText(summary); });
            } catch (Exception e) {
                failure(g, e);
                final String summary = "测试中断：尝试 " + sent + " · 已确认 " + ack + "；请对照电脑记录";
                handler.post(() -> { if (g == generation) result.setText(summary); });
            } finally {
                handler.post(() -> {
                    batchRunning = false;
                    if (g == generation && running) { setActions(syncReady); handler.post(ticker); }
                });
            }
        });
    }
    private void failure(int g, Exception e) {
        handler.post(() -> {
            if (g != generation || !running) return;
            syncReady = false;
            status.setText("连接失败，正在重试 · 检查地址、同一网络与防火墙");
            status.setTextColor(Color.rgb(166,68,38)); setActions(false);
        });
    }
    private void startDetection() {
        if (!running || !syncReady || runId.isEmpty() || batchRunning) {
            sensorStatus.setText("先连接电脑并完成时间同步");
            return;
        }
        Sensor source = linearSensor != null ? linearSensor : accelerometer;
        if (source == null || !sensors.registerListener(this, source, SensorManager.SENSOR_DELAY_GAME)) {
            sensorStatus.setText("无法启动传感器，请检查手机支持");
            return;
        }
        detecting = true; gravityReady = false; gravityTimestamp = 0;
        detector.resetForStart();
        resetBaseline();
        detect.setText("停止体感识别");
        calibrate.setEnabled(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        sensorStatus.setText("静止基线采集中");
    }
    private void stopDetection() {
        if (!detecting) return;
        detecting = false;
        sensors.unregisterListener(this);
        detect.setText("开始体感识别");
        if (!running) getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        sensorStatus.setText("体感识别已停止");
    }
    private void saveCalibration() {
        if (!detector.isCalibrated()) return;
        double[] axis = detector.copyAxis();
        getPreferences(0).edit().putFloat(CAL_X, (float) axis[0]).putFloat(CAL_Y, (float) axis[1])
            .putFloat(CAL_Z, (float) axis[2]).putFloat(CAL_THRESHOLD, (float) detector.getThreshold())
            .putFloat(CAL_PEAK, (float) detector.getCalibrationPeak()).apply();
        calibrationSaved = true;
        sensitivity.setProgress((int) Math.round((detector.getThreshold() - 2.0) / 0.2));
        thresholdLabel.setText(String.format(java.util.Locale.US, "动作阈值 %.1f m/s²", detector.getThreshold()));
        updateSensorInfo();
    }
    private void loadCalibration() {
        android.content.SharedPreferences prefs = getPreferences(0);
        if (!prefs.contains(CAL_X)) return;
        detector.restoreCalibration(prefs.getFloat(CAL_X, 0), prefs.getFloat(CAL_Y, 0),
            prefs.getFloat(CAL_Z, 0), prefs.getFloat(CAL_THRESHOLD, 3.2f), prefs.getFloat(CAL_PEAK, 0));
        if (detector.isCalibrated()) {
            sensorStatus.setText("已加载上次校准方向");
            saveCalibration();
        }
    }
    private void updateSensorInfo() {
        String source = linearSensor != null ? "线性加速度" :
            accelerometer != null ? "加速度计重力补偿" : "无可用传感器";
        sensorInfo.setText(source + (detector.isCalibrated() ?
            String.format(java.util.Locale.US, " · 校准峰值 %.1f m/s²", detector.getCalibrationPeak()) : " · 未校准"));
    }
    private void resetBaseline() {
        zeroReady = false; zeroCount = 0; zeroStart = -1;
        for (int i = 0; i < 3; i++) { zeroSum[i] = 0; zeroBias[i] = 0; }
        sensorStatus.setText("静止基线采集中");
    }
    @Override public void onSensorChanged(SensorEvent event) {
        if (!detecting || event.values.length < 3) return;
        double x, y, z;
        if (event.sensor.getType() == Sensor.TYPE_LINEAR_ACCELERATION) {
            x = event.values[0]; y = event.values[1]; z = event.values[2];
        } else {
            if (!gravityReady) {
                System.arraycopy(event.values, 0, gravity, 0, 3);
                gravityReady = true; gravityTimestamp = event.timestamp;
            } else {
                double dt = Math.max(0.001, Math.min(0.2, (event.timestamp - gravityTimestamp) / 1_000_000_000.0));
                double alpha = dt / (0.25 + dt);
                for (int i = 0; i < 3; i++) gravity[i] += alpha * (event.values[i] - gravity[i]);
                gravityTimestamp = event.timestamp;
            }
            x = event.values[0] - gravity[0];
            y = event.values[1] - gravity[1];
            z = event.values[2] - gravity[2];
        }
        long timeMs = event.timestamp / 1_000_000L;
        if (!zeroReady) {
            if (Math.sqrt(x * x + y * y + z * z) > 1.8) {
                resetBaseline();
                return;
            }
            if (zeroStart < 0) zeroStart = timeMs;
            zeroSum[0] += x; zeroSum[1] += y; zeroSum[2] += z; zeroCount++;
            if (timeMs - zeroStart < 350 || zeroCount < 10) return;
            for (int i = 0; i < 3; i++) zeroBias[i] = zeroSum[i] / zeroCount;
            zeroReady = true;
            detector.announceReady();
            return;
        }
        x -= zeroBias[0]; y -= zeroBias[1]; z -= zeroBias[2];
        detector.accept(x, y, z, event.timestamp);
        if (timeMs - lastSignal >= 100) {
            lastSignal = timeMs;
            double[] axis = detector.copyAxis();
            signal.setText(String.format(java.util.Locale.US,
                "上挥 %d · 下挥 %d · 轴向 %+.1f m/s²",
                upCount, downCount, x * axis[0] + y * axis[1] + z * axis[2]));
        }
    }
    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    @Override public void onPause() { stopDetection(); stop(); super.onPause(); }
    @Override public void onDestroy() { sensors.unregisterListener(this); network.shutdownNow(); super.onDestroy(); }
}
