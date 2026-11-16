package com.mihayou.sensor;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.hardware.*;
import android.os.*;
import android.view.WindowManager;
import android.widget.*;
import java.util.Locale;

public class MainActivity extends Activity implements SensorEventListener {
    private static final int BG = Color.rgb(18, 24, 32), FG = Color.rgb(235, 242, 249),
        ACCENT = Color.rgb(68, 210, 178);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SensorManager sensors;
    private Sensor accelerometer, orientation;
    private BleSensorPeripheral ble;
    private boolean running;
    private long lastUi;
    private TextView status, readings;
    private Button start, stop;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        orientation = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (orientation == null) orientation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        buildUi();
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
        TextView title = label("咪哈友 · 蓝牙终端", 26); title.setTextColor(ACCENT); content.addView(title);
        content.addView(label("原始传感器终端 0.6.1", 14));
        status = label("状态：等待连接电脑", 17); content.addView(status);
        readings = label("传感器：等待启动", 14); readings.setMinLines(3); content.addView(readings);
        content.addView(label("动作识别由电脑完成", 20));
        content.addView(label("手机发送原始加速度与姿态，握姿校准和动作识别在电脑完成。请保持此页面在前台。", 16));
        start = button("启动蓝牙"); content.addView(start);
        stop = button("停止"); content.addView(stop);
        start.setEnabled(accelerometer != null); stop.setEnabled(false);
        start.setOnClickListener(view -> startBle());
        stop.setOnClickListener(view -> halt());
        Button help = button("帮助"); content.addView(help);
        help.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("蓝牙体感连接")
            .setMessage("1. 开启手机蓝牙，点“启动蓝牙”，允许附近设备权限。\n2. 电脑用 Chrome 或 Edge 打开本机游戏页，点“连接手机蓝牙”，选择此手机（可能显示手机名称或设备地址）。\n3. 电脑点“校准动作”，保持握姿静止约1秒，再做一次上挥，等待就绪。\n4. 切出 App 将停止采集；返回后重新启动、连接并校准。")
            .setPositiveButton("关闭", null).show());
        setContentView(scroll);
        if (Build.VERSION.SDK_INT >= 30) content.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
            view.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, dp(20) + bars.bottom);
            return insets;
        });
    }
    private void halt() {
        running = false;
        BleSensorPeripheral old = ble; ble = null;
        if (old != null) old.close();
        sensors.unregisterListener(this); start.setEnabled(accelerometer != null);
        stop.setEnabled(false);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        status.setText("状态：已停止");
    }
    @Override public void onSensorChanged(SensorEvent event) {
        if (!running || event.values.length < 3) return;
        int type = event.sensor.getType();
        if (ble == null) return;
        if (type == Sensor.TYPE_GAME_ROTATION_VECTOR || type == Sensor.TYPE_ROTATION_VECTOR) {
            float sign = event.values.length >= 4 && event.values[3] < 0 ? -1 : 1;
            ble.publish(SensorPacket.ROTATION, sign * event.values[0], sign * event.values[1],
                sign * event.values[2], event.timestamp);
            return;
        }
        if (type != Sensor.TYPE_ACCELEROMETER) return;
        long now = event.timestamp;
        ble.publish(SensorPacket.ACCELERATION, event.values[0], event.values[1], event.values[2], now);
        if (now - lastUi >= 100_000_000L) {
            lastUi = now;
            readings.setText(String.format(Locale.US, "原始加速度 %+.2f / %+.2f / %+.2f m/s²\n%s",
                event.values[0], event.values[1], event.values[2], orientation != null ? "同时发送姿态数据" : "无姿态传感器，电脑使用重力滤波"));
        }
    }
    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    @Override protected void onPause() {
        halt();
        super.onPause();
    }
    @Override protected void onDestroy() { if (ble != null) ble.close(); sensors.unregisterListener(this); super.onDestroy(); }
    private static final int BLE_PERMISSION_REQUEST = 41;
    private void startBle() {
        if (running) return;
        if (accelerometer == null) { status.setText("缺少加速度传感器"); return; }
        if (Build.VERSION.SDK_INT >= 31 &&
            (checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) != android.content.pm.PackageManager.PERMISSION_GRANTED ||
             checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) != android.content.pm.PackageManager.PERMISSION_GRANTED)) {
            requestPermissions(new String[] { android.Manifest.permission.BLUETOOTH_ADVERTISE,
                android.Manifest.permission.BLUETOOTH_CONNECT }, BLE_PERMISSION_REQUEST);
            return;
        }
        final BleSensorPeripheral[] instance = new BleSensorPeripheral[1];
        instance[0] = new BleSensorPeripheral(this, message -> ui.post(() -> {
            if (ble == instance[0]) status.setText("状态：蓝牙 " + message);
        }), () -> ui.post(() -> { if (ble == instance[0]) { halt(); status.setText("蓝牙启动或发送失败，请重新启动"); } }));
        ble = instance[0];
        try {
          if (ble.start()) {
            if (orientation != null) sensors.registerListener(this, orientation, 20000);
            if (!sensors.registerListener(this, accelerometer, 20000)) { halt(); status.setText("无法启动传感器"); return; }
            running = true; start.setEnabled(false); stop.setEnabled(true);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
          } else { halt(); status.setText("启动失败：请开启蓝牙，并确认手机支持 BLE 外设广播"); }
        } catch (SecurityException error) { halt(); status.setText("蓝牙权限不可用，请重新授权附近设备权限"); }
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != BLE_PERMISSION_REQUEST) return;
        boolean granted = results.length == 2;
        for (int result : results) granted &= result == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (granted) startBle();
        else status.setText("需要附近设备的广播和连接权限才能启动蓝牙");
    }
}
