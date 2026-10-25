package com.mihayou.sensor;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.hardware.*;
import android.os.*;
import android.view.WindowManager;
import android.widget.*;
import com.mihayou.linktest.SwingDetector;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;

// Keeps the supplied APK's screen structure and pose-compensated sensor pipeline.
public class MainActivity extends Activity implements SensorEventListener {
    private static final int BG = Color.rgb(18, 24, 32), FG = Color.rgb(235, 242, 249),
        ACCENT = Color.rgb(68, 210, 178);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final float[] rotation = new float[9], reference = new float[9], angles = new float[3],
        previous = new float[3], gravity = new float[3], gyro = new float[3], filtered = new float[3];
    private SensorManager sensors;
    private Sensor accelerometer, orientation, gyroscope;
    private SensorLink link;
    private SwingDetector detector;
    private boolean running, calibrating, initialized, haveRotation, usePose, rearming, foreground;
    private long stableSince, ignoreUntil, lastUi, sequence;
    private String sessionId = UUID.randomUUID().toString(), detectorState = "未校准";
    private int upCount, downCount;
    private EditText endpoint;
    private TextView status, readings, recent, counts, network, rtt, thresholdLabel, logView;
    private Button start, stop, recalibrate, rearm;
    private CheckBox send;
    private SeekBar threshold;
    private final java.util.ArrayDeque<String> logs = new java.util.ArrayDeque<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        orientation = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (orientation == null) orientation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        gyroscope = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        buildUi();
        detector = new SwingDetector(new SwingDetector.Listener() {
            public void onState(String value) {
                detectorState = value;
                if (!calibrating) status.setText("状态：" + value);
                if (value.contains("校准完成")) updateThreshold();
            }
            public void onAction(String action, double sourceTime, double peak) {
                long number = ++sequence;
                if ("swing_up".equals(action)) upCount++; else downCount++;
                recent.setText("最近动作：" + ("swing_up".equals(action) ? "上挥（跳跃）" : "下挥（下蹲）"));
                counts.setText("上挥 " + upCount + "    下挥 " + downCount);
                logs.addFirst("#" + number + "  " + action + "  " + String.format(Locale.US, "%.1f m/s²", peak));
                while (logs.size() > 5) logs.removeLast();
                StringBuilder text = new StringBuilder();
                for (String row : logs) text.append(row).append('\n');
                logView.setText(text.toString().trim());
                if (send.isChecked()) link.send(sessionId, number, action, sourceTime, false);
            }
        });
        String clientId = getPreferences(0).getString("clientId", "");
        if (clientId.isEmpty()) {
            clientId = UUID.randomUUID().toString();
            getPreferences(0).edit().putString("clientId", clientId).apply();
        }
        link = new SensorLink(clientId, Build.MANUFACTURER + " " + Build.MODEL + " · 原版增强",
            () -> SystemClock.elapsedRealtimeNanos() / 1_000_000.0, new SensorLink.Listener() {
                public void state(boolean ready, String message, double value) {
                    ui.post(() -> {
                        if (!foreground) return;
                        network.setText("连接状态：" + message);
                        network.setTextColor(ready ? ACCENT : FG);
                        rtt.setText(Double.isFinite(value) ? String.format(Locale.US, "手机往返 RTT  %.1f ms", value) : "手机往返 RTT  —");
                    });
                }
                public void action(String message) { ui.post(() -> { if (foreground) network.setText(message); }); }
            });
        threshold.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(SeekBar bar, int value, boolean fromUser) {
                if (fromUser) { detector.setThreshold(2 + value * .2); updateThresholdLabel(); }
            }
            public void onStartTrackingTouch(SeekBar bar) {}
            public void onStopTrackingTouch(SeekBar bar) {}
        });
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView label(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setTextColor(FG);
        view.setPadding(0, dp(7), 0, dp(7));
        return view;
    }
    private Button button(String value) {
        Button view = new Button(this); view.setText(value); view.setAllCaps(false); view.setMinHeight(dp(48));
        return view;
    }
    private void buildUi() {
        ScrollView scroll = new ScrollView(this); scroll.setBackgroundColor(BG);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(32), dp(20), dp(28)); scroll.addView(content);
        TextView title = label("咪哈友 · 挥动控制器", 26); title.setTextColor(ACCENT); content.addView(title);
        content.addView(label("原版增强 0.5.0", 14));
        status = label("状态：未开始", 17); content.addView(status);
        readings = label("加速度：等待传感器", 14); readings.setMinLines(3); content.addView(readings);
        recent = label("最近动作：无", 24); content.addView(recent);
        counts = label("上挥 0    下挥 0", 16); content.addView(counts);
        start = button("开始检测并示教"); content.addView(start);
        recalibrate = button("重新示教上挥方向"); content.addView(recalibrate);
        stop = button("停止检测"); content.addView(stop);
        rearm = button("已回位，重新就绪"); content.addView(rearm);
        start.setEnabled(accelerometer != null); recalibrate.setEnabled(false); stop.setEnabled(false); rearm.setEnabled(false);
        start.setOnClickListener(view -> begin()); recalibrate.setOnClickListener(view -> beginCalibration());
        stop.setOnClickListener(view -> halt());
        rearm.setOnClickListener(view -> {
            if (!running || !detector.isCalibrated()) return;
            rearming = true; stableSince = 0; status.setText("状态：保持静止，正在重新就绪");
        });
        thresholdLabel = label("动作阈值 3.2 m/s²", 14); content.addView(thresholdLabel);
        threshold = new SeekBar(this); threshold.setMax(30); threshold.setProgress(6); content.addView(threshold);
        content.addView(label("电脑连接", 18));
        endpoint = new EditText(this); endpoint.setSingleLine(true);
        endpoint.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        endpoint.setTextSize(17); endpoint.setTextColor(FG); endpoint.setHintTextColor(Color.LTGRAY);
        endpoint.setHint("ws://电脑IP:端口/sensor"); endpoint.setText(getPreferences(0).getString("endpoint", ""));
        GradientDrawable surface = new GradientDrawable(); surface.setColor(Color.rgb(30, 42, 55));
        surface.setCornerRadius(dp(6)); surface.setStroke(dp(1), Color.rgb(104, 125, 145));
        endpoint.setBackground(surface); endpoint.setPadding(dp(12), dp(12), dp(12), dp(12)); content.addView(endpoint);
        LinearLayout buttons = new LinearLayout(this);
        Button connect = button("连接并测量"), disconnect = button("断开");
        buttons.addView(connect, new LinearLayout.LayoutParams(0, dp(52), 1));
        buttons.addView(disconnect, new LinearLayout.LayoutParams(0, dp(52), 1)); content.addView(buttons);
        connect.setOnClickListener(view -> {
            try {
                String address = endpoint.getText().toString().trim();
                if (address.startsWith("http://")) address = "ws://" + address.substring(7);
                if (!address.contains("://")) address = "ws://" + address;
                link.connect(address); getPreferences(0).edit().putString("endpoint", address).apply();
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (Exception error) { network.setText(error.getMessage()); }
        });
        disconnect.setOnClickListener(view -> { link.disconnect(); network.setText("已断开"); rtt.setText("手机往返 RTT  —"); });
        send = new CheckBox(this); send.setText("识别后发送给电脑"); send.setTextColor(FG); send.setChecked(true);
        send.setButtonTintList(ColorStateList.valueOf(ACCENT)); content.addView(send);
        network = label("连接状态：未连接", 14); content.addView(network);
        rtt = label("手机往返 RTT  —", 21); rtt.setTextColor(ACCENT); content.addView(rtt);
        content.addView(label("动作日志", 16)); logView = label("暂无动作", 13); logView.setMinLines(5); content.addView(logView);
        Button help = button("帮助"); content.addView(help);
        help.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("动作示教")
            .setMessage("先拿稳约1秒，再朝你想定义为上挥的方向明显挥一次。末端停稳，缓慢反向回位并停稳，完成示教。反方向正式挥动为下挥。每次动作后都完成末端暂停、回位和停稳。电脑准备页可调判定偏移或做八拍校准。")
            .setPositiveButton("关闭", null).show());
        setContentView(scroll);
        if (Build.VERSION.SDK_INT >= 30) content.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
            view.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, dp(20) + bars.bottom);
            return insets;
        });
    }
    private void updateThresholdLabel() {
        thresholdLabel.setText(String.format(Locale.US, "动作阈值 %.1f m/s²", detector.getThreshold()));
    }
    private void updateThreshold() {
        threshold.setProgress((int) Math.round((detector.getThreshold() - 2) / .2)); updateThresholdLabel();
    }
    private void begin() {
        if (accelerometer == null) return;
        running = true; start.setEnabled(false); stop.setEnabled(true); recalibrate.setEnabled(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        beginCalibration();
    }
    private void beginCalibration() {
        if (!running) return;
        sensors.unregisterListener(this);
        sessionId = UUID.randomUUID().toString(); sequence = 0;
        calibrating = true; rearming = false; initialized = false; haveRotation = false; stableSince = 0;
        Arrays.fill(gyro, 0);
        usePose = orientation != null && sensors.registerListener(this, orientation, 20000);
        if (gyroscope != null) sensors.registerListener(this, gyroscope, 20000);
        if (!sensors.registerListener(this, accelerometer, 20000)) { halt(); status.setText("无法启动传感器"); return; }
        detector.beginCalibration(); rearm.setEnabled(true);
        status.setText("状态：保持握姿静止约1秒");
    }
    private void halt() {
        running = false; calibrating = false; rearming = false;
        sensors.unregisterListener(this); start.setEnabled(accelerometer != null);
        stop.setEnabled(false); recalibrate.setEnabled(false); rearm.setEnabled(false);
        status.setText("状态：已停止");
    }
    @Override public void onSensorChanged(SensorEvent event) {
        if (!running || event.values.length < 3) return;
        int type = event.sensor.getType();
        if (type == Sensor.TYPE_GYROSCOPE) { System.arraycopy(event.values, 0, gyro, 0, 3); return; }
        if (type == Sensor.TYPE_GAME_ROTATION_VECTOR || type == Sensor.TYPE_ROTATION_VECTOR) {
            SensorManager.getRotationMatrixFromVector(rotation, event.values); haveRotation = true; return;
        }
        if (type != Sensor.TYPE_ACCELEROMETER) return;
        long now = event.timestamp;
        float change = 0;
        if (initialized) for (int i = 0; i < 3; i++) change += (event.values[i] - previous[i]) * (event.values[i] - previous[i]);
        else { initialized = true; System.arraycopy(event.values, 0, gravity, 0, 3); }
        System.arraycopy(event.values, 0, previous, 0, 3);
        if (calibrating) {
            double gyroStrength = Math.sqrt(gyro[0] * gyro[0] + gyro[1] * gyro[1] + gyro[2] * gyro[2]);
            double strength = Math.sqrt(event.values[0] * event.values[0] + event.values[1] * event.values[1] + event.values[2] * event.values[2]);
            if (change < .25 && gyroStrength < .25 && Math.abs(strength - 9.80665) < .9 && (!usePose || haveRotation)) {
                if (stableSince == 0) stableSince = now;
            } else stableSince = 0;
            if (stableSince != 0 && now - stableSince >= 1_000_000_000L) {
                if (usePose) System.arraycopy(rotation, 0, reference, 0, 9);
                System.arraycopy(event.values, 0, gravity, 0, 3);
                ignoreUntil = now + 180_000_000L; calibrating = false;
                status.setText("状态：请示范一次上挥，然后停稳、回位");
            }
            return;
        }
        if (usePose && haveRotation) PoseFrame.project(reference, rotation, event.values, filtered, angles);
        else for (int i = 0; i < 3; i++) {
            gravity[i] = gravity[i] * .94f + event.values[i] * .06f;
            filtered[i] = event.values[i] - gravity[i];
        }
        if (now <= ignoreUntil) return;
        if (rearming) {
            double magnitude = Math.sqrt(filtered[0] * filtered[0] + filtered[1] * filtered[1] + filtered[2] * filtered[2]);
            if (magnitude > 1.8) stableSince = 0;
            else {
                if (stableSince == 0) stableSince = now;
                if (now - stableSince >= 350_000_000L) { rearming = false; detector.resetForStart(); detector.announceReady(); }
            }
            return;
        }
        detector.accept(filtered[0], filtered[1], filtered[2], now);
        if (now - lastUi >= 100_000_000L) {
            lastUi = now;
            double[] axis = detector.copyAxis();
            readings.setText(String.format(Locale.US, "轴向加速度 %+.2f m/s²\n%s\n%s",
                filtered[0] * axis[0] + filtered[1] * axis[1] + filtered[2] * axis[2],
                usePose ? "原版握姿补偿" : "原版重力滤波", detectorState));
        }
    }
    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    @Override protected void onResume() { super.onResume(); foreground = true; }
    @Override protected void onPause() {
        foreground = false; halt(); if (link != null) link.disconnect();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        network.setText("已暂停，回到前台后重新连接"); rtt.setText("手机往返 RTT  —");
        super.onPause();
    }
    @Override protected void onDestroy() { if (link != null) link.close(); sensors.unregisterListener(this); super.onDestroy(); }
}
