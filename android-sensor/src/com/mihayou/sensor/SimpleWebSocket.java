package com.mihayou.sensor;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

// Adapted from the supplied APK's send-only WebSocket transport.
public final class SimpleWebSocket {
    public interface Listener { void opened(); void failed(String message); }
    private final URI uri;
    private final Listener listener;
    private volatile Socket socket;
    private volatile OutputStream out;
    private volatile boolean closed;
    public SimpleWebSocket(String endpoint, Listener listener) throws Exception {
        uri = new URI(endpoint);
        if (!"ws".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null)
            throw new IllegalArgumentException("请填写 ws://电脑IP:端口/sensor");
        this.listener = listener;
    }
    public void connect() {
        new Thread(() -> {
            try {
                Socket connection = new Socket();
                socket = connection;
                if (closed) { connection.close(); return; }
                connection.connect(new InetSocketAddress(uri.getHost(), uri.getPort() > 0 ? uri.getPort() : 80), 1500);
                connection.setSoTimeout(2500);
                OutputStream stream = connection.getOutputStream();
                byte[] nonce = new byte[16]; new SecureRandom().nextBytes(nonce);
                String key = Base64.getEncoder().encodeToString(nonce);
                String path = uri.getRawPath();
                if (path == null || path.isEmpty()) path = "/sensor";
                String request = "GET " + path + " HTTP/1.1\r\nHost: " + uri.getHost() + ":" +
                    (uri.getPort() > 0 ? uri.getPort() : 80) + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " +
                    key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
                stream.write(request.getBytes(StandardCharsets.US_ASCII)); stream.flush();
                InputStream input = connection.getInputStream();
                ByteArrayOutputStream header = new ByteArrayOutputStream();
                int match = 0;
                byte[] ending = {13, 10, 13, 10};
                while (match < 4) {
                    int value = input.read();
                    if (value < 0 || header.size() >= 8192) throw new IOException("WebSocket握手失败");
                    header.write(value);
                    match = value == ending[match] ? match + 1 : value == 13 ? 1 : 0;
                }
                String response = header.toString("US-ASCII");
                String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                    .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
                if (!response.startsWith("HTTP/1.1 101 ") || !response.toLowerCase(java.util.Locale.ROOT)
                    .contains("sec-websocket-accept: " + accept.toLowerCase(java.util.Locale.ROOT)))
                    throw new IOException("WebSocket握手未通过");
                if (closed) { connection.close(); return; }
                out = stream; listener.opened();
            } catch (Exception error) {
                close();
                listener.failed(error.getMessage() == null ? "连接失败" : error.getMessage());
            }
        }, "MihaSensor-WebSocket").start();
    }
    public synchronized void sendText(String text) throws IOException {
        if (closed || out == null) throw new IOException("尚未连接");
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        if (data.length > 65535) throw new IOException("消息过长");
        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        frame.write(129);
        if (data.length < 126) frame.write(data.length | 128);
        else { frame.write(254); frame.write((data.length >>> 8) & 255); frame.write(data.length & 255); }
        byte[] mask = new byte[4]; new SecureRandom().nextBytes(mask); frame.write(mask);
        for (int i = 0; i < data.length; i++) frame.write(data[i] ^ mask[i % 4]);
        out.write(frame.toByteArray()); out.flush();
    }
    public void close() {
        closed = true;
        Socket connection = socket;
        out = null; socket = null;
        if (connection != null) try { connection.close(); } catch (IOException ignored) {}
    }
}
