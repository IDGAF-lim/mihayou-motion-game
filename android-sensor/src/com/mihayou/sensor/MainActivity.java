package com.mihayou.sensor;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.hardware.*;
import android.os.*;
import android.view.WindowManager;
import android.widget.*;
import java.util.Arrays;
import java.util.Locale;

// Keeps the supplied APK's screen structure and pose-compensated sensor pipeline.
public class MainActivity extends Activity implements SensorEventListener {
    private static final int BG = Color.rgb(18, 24, 32), FG = Color.rgb(235, 242, 249),
        ACCENT = Color.rgb(68, 210, 178);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final float[] rotation = new float[9], reference = new float[9], angles = new float[3],
        previous = new float[3], gravity = new float[3], gyro = new float[3], filtered = new float[3];
    private SensorManager sensors;
    private Sensor accelerometer, orientation, gyroscope;
    private BleSensorPeripheral ble;
    private boolean running, calibrating, initialized, haveRotation, usePose;
    private long stableSince, ignoreUntil, lastUi;
    private TextView status, readings;
    private Button start, stop, recalibrate;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        orientation = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (orientation == null) orientation = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        gyroscope = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
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
        TextView title = label("咪哈友 · 挥动控制器", 26); title.setTextColor(ACCENT); content.addView(title);
        content.addView(label("蓝牙传感器终端 0.6.0", 14));
        status = label("状态：等待连接电脑", 17); content.addView(status);
        readings = label("传感器：等待启动", 14); readings.setMinLines(3); content.addView(readings);
        content.addView(label("动作识别由电脑完成", 20));
        content.addView(label("手机只采集并发送加速度数据", 16));
        start = button("启动传感器"); content.addView(start);
        recalibrate = button("重新校准手机握姿"); content.addView(recalibrate);
        stop = button("停止采集"); content.addView(stop);
        start.setEnabled(accelerometer != null); recalibrate.setEnabled(false); stop.setEnabled(false);
        start.setOnClickListener(view -> begin()); recalibrate.setOnClickListener(view -> beginCalibration());
        stop.setOnClickListener(view -> halt());
        Button bluetooth = button("启动电脑蓝牙传感器");
        content.addView(bluetooth);
        bluetooth.setOnClickListener(view -> startBle());
        Button help = button("帮助"); content.addView(help);
        help.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("蓝牙体感连接")
            .setMessage("在手机点“启动电脑蓝牙传感器”，允许蓝牙权限并保持 App 前台。电脑打开游戏页后点“连接手机蓝牙”，选择 MihaYou 传感器。动作方向在电脑游戏页校准；电脑完成识别和游戏判定。")
            .setPositiveButton("关闭", null).show());
        setContentView(scroll);
        if (Build.VERSION.SDK_INT >= 30) content.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
            view.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, dp(20) + bars.bottom);
            return insets;
        });
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
        calibrating = true; initialized = false; haveRotation = false; stableSince = 0;
        Arrays.fill(gyro, 0);
        usePose = orientation != null && sensors.registerListener(this, orientation, 20000);
        if (gyroscope != null) sensors.registerListener(this, gyroscope, 20000);
        if (!sensors.registerListener(this, accelerometer, 20000)) { halt(); status.setText("无法启动传感器"); return; }
        status.setText("状态：保持握姿静止约1秒");
    }
    private void halt() {
        running = false; calibrating = false;
        sensors.unregisterListener(this); start.setEnabled(accelerometer != null);
        stop.setEnabled(false); recalibrate.setEnabled(false);
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
                status.setText("状态：传感器已校准，电脑端可校准动作方向");
            }
            return;
        }
        if (usePose && haveRotation) PoseFrame.project(reference, rotation, event.values, filtered, angles);
        else for (int i = 0; i < 3; i++) {
            gravity[i] = gravity[i] * .94f + event.values[i] * .06f;
            filtered[i] = event.values[i] - gravity[i];
        }
        if (now <= ignoreUntil) return;
        if (ble != null) ble.publish(filtered[0], filtered[1], filtered[2], now);
        if (now - lastUi >= 100_000_000L) {
            lastUi = now;
            readings.setText(String.format(Locale.US, "原始加速度 %+.2f / %+.2f / %+.2f m/s²\n%s\n电脑端负责动作识别",
                filtered[0], filtered[1], filtered[2], usePose ? "姿态补偿已启用" : "重力滤波已启用"));
        }
    }
    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    @Override protected void onPause() {
        halt();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onPause();
    }
    @Override protected void onDestroy() { if (ble != null) ble.close(); sensors.unregisterListener(this); super.onDestroy(); }
    private static final int BLE_PERMISSION_REQUEST = 41;
    private void startBle() {
        if (Build.VERSION.SDK_INT >= 31 &&
            (checkSelfPermission(android.Manifest.permission.BLUETOOTH_ADVERTISE) != android.content.pm.PackageManager.PERMISSION_GRANTED ||
             checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) != android.content.pm.PackageManager.PERMISSION_GRANTED)) {
            requestPermissions(new String[] { android.Manifest.permission.BLUETOOTH_ADVERTISE,
                android.Manifest.permission.BLUETOOTH_CONNECT }, BLE_PERMISSION_REQUEST);
            return;
        }
        if (ble != null) ble.close();
        ble = new BleSensorPeripheral(this, message -> ui.post(() -> status.setText("状态：蓝牙 " + message)));
        if (ble.start()) {
            if (!running) begin();
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == BLE_PERMISSION_REQUEST && results.length > 0 &&
            results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) startBle();
    }
}
