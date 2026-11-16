package com.mihayou.sensor;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.Build;
import android.os.ParcelUuid;
import java.util.UUID;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.Map;
import java.util.HashMap;
import android.os.SystemClock;

final class BleSensorPeripheral implements AutoCloseable {
    static final UUID SERVICE = UUID.fromString("f000aa00-0451-4000-b000-000000000000");
    static final UUID STREAM = UUID.fromString("f000aa01-0451-4000-b000-000000000000");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    interface Listener { void state(String message); }
    private final Context context;
    private final Listener listener;
    private final Runnable onFailure;
    private BluetoothGattServer server;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattCharacteristic stream;
    private AdvertiseCallback advertiseCallback;
    private final Set<BluetoothDevice> subscribers = new HashSet<>();
    private final Set<BluetoothDevice> sending = new HashSet<>();
    private final Set<BluetoothDevice> connected = new HashSet<>();
    private final Map<BluetoothDevice, Pending[]> pending = new HashMap<>();
    private long lastTimestampNs = -1;
    private long sequence;
    private boolean closed;
    private static final class Pending {
        final byte[] bytes;
        final long timestampNs;
        final long order;
        Pending(byte[] bytes, long timestampNs, long order) {
            this.bytes = bytes; this.timestampNs = timestampNs; this.order = order;
        }
    }

    BleSensorPeripheral(Context context, Listener listener, Runnable onFailure) {
        this.context = context;
        this.listener = listener;
        this.onFailure = onFailure;
    }
    synchronized boolean start() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled() || !adapter.isMultipleAdvertisementSupported()) {
            listener.state("手机不支持 BLE 外设或蓝牙未开启");
            return false;
        }
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) { listener.state("BLE 广播不可用"); return false; }
        server = manager.openGattServer(context, new BluetoothGattServerCallback() {
            @Override public void onConnectionStateChange(BluetoothDevice device, int status, int state) {
                synchronized (BleSensorPeripheral.this) {
                    if (closed) return;
                    if (state != BluetoothProfile.STATE_CONNECTED) {
                        subscribers.remove(device);
                        sending.remove(device);
                        pending.remove(device); connected.remove(device);
                    } else connected.add(device);
                    listener.state(state == BluetoothProfile.STATE_CONNECTED ?
                        "电脑已连接，等待订阅" : "等待电脑蓝牙连接");
                }
            }
            @Override public void onServiceAdded(int status, BluetoothGattService service) {
                synchronized (BleSensorPeripheral.this) {
                    if (closed) return;
                    if (status != BluetoothGatt.GATT_SUCCESS) { fail("蓝牙服务注册失败：" + status); return; }
                    try { startAdvertising(); } catch (SecurityException error) { fail("蓝牙权限已撤销"); }
                }
            }
            @Override public void onDescriptorWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattDescriptor descriptor, boolean preparedWrite,
                    boolean responseNeeded, int offset, byte[] value) {
                synchronized (BleSensorPeripheral.this) {
                    if (closed || server == null) return;
                    boolean enable = Arrays.equals(value, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    boolean disable = Arrays.equals(value, BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
                    int result = !CCCD.equals(descriptor.getUuid()) || preparedWrite || offset != 0 ||
                        (!enable && !disable) ? BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED : BluetoothGatt.GATT_SUCCESS;
                    if (result == BluetoothGatt.GATT_SUCCESS) {
                        if (enable) { subscribers.add(device); pending.put(device, new Pending[2]); listener.state("电脑已订阅传感器"); }
                        else { subscribers.remove(device); pending.remove(device); }
                    }
                    if (responseNeeded) server.sendResponse(device, requestId, result, 0, null);
                }
            }
            @Override public void onDescriptorReadRequest(BluetoothDevice device, int requestId,
                    int offset, BluetoothGattDescriptor descriptor) {
                synchronized (BleSensorPeripheral.this) {
                    if (closed || server == null) return;
                    server.sendResponse(device, requestId, offset == 0 ? BluetoothGatt.GATT_SUCCESS :
                        BluetoothGatt.GATT_INVALID_OFFSET, 0, subscribers.contains(device) ?
                        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
                }
            }
            @Override public void onNotificationSent(BluetoothDevice device, int status) {
                synchronized (BleSensorPeripheral.this) {
                    sending.remove(device);
                    if (closed) return;
                    if (status != BluetoothGatt.GATT_SUCCESS) { fail("传感器通知失败：" + status); return; }
                    drain(device);
                }
            }
        });
        if (server == null) { listener.state("无法创建蓝牙服务"); return false; }
        BluetoothGattService service = new BluetoothGattService(SERVICE,
            BluetoothGattService.SERVICE_TYPE_PRIMARY);
        stream = new BluetoothGattCharacteristic(STREAM,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0);
        stream.addDescriptor(new BluetoothGattDescriptor(CCCD,
            BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE));
        service.addCharacteristic(stream);
        if (!server.addService(service)) { listener.state("无法注册蓝牙服务"); close(); return false; }
        return true;
    }
    private void startAdvertising() {
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true).setTimeout(0).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false).addServiceUuid(new ParcelUuid(SERVICE)).build();
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings result) {
                synchronized (BleSensorPeripheral.this) { if (!closed) listener.state("正在广播，等待电脑蓝牙连接"); }
            }
            @Override public void onStartFailure(int errorCode) {
                synchronized (BleSensorPeripheral.this) { if (!closed) fail("蓝牙广播失败：" + errorCode); }
            }
        };
        advertiser.startAdvertising(settings, data, advertiseCallback);
    }
    synchronized void publish(int kind, float x, float y, float z, long timestampNs) {
        if (closed || server == null || stream == null) return;
        if (timestampNs < lastTimestampNs) return;
        lastTimestampNs = timestampNs;
        long order = sequence++;
        Pending value = new Pending(SensorPacket.encode(kind, (int) order, timestampNs, x, y, z), timestampNs, order);
        for (BluetoothDevice device : new HashSet<>(subscribers)) {
            // Coalesce each sensor separately so pose cannot starve acceleration.
            Pending[] slots = pending.get(device);
            if (slots == null) continue;
            slots[kind - 1] = value;
            drain(device);
        }
    }
    private void drain(BluetoothDevice device) {
        if (closed || sending.contains(device)) return;
        Pending[] slots = pending.get(device);
        if (slots == null) return;
        long now = SystemClock.elapsedRealtimeNanos();
        for (int i = 0; i < slots.length; i++)
            if (slots[i] != null && now - slots[i].timestampNs > 150_000_000L) slots[i] = null;
        int index = slots[0] == null ? 1 : slots[1] == null ? 0 :
            slots[0].order <= slots[1].order ? 0 : 1;
        Pending next = slots[index];
        if (next == null) return;
        slots[index] = null;
        sending.add(device);
        try {
            boolean accepted;
            if (Build.VERSION.SDK_INT >= 33) {
                accepted = server.notifyCharacteristicChanged(device, stream, false, next.bytes) == 0;
            } else {
                stream.setValue(next.bytes);
                accepted = server.notifyCharacteristicChanged(device, stream, false);
            }
            if (!accepted) sending.remove(device);
        } catch (SecurityException error) { sending.remove(device); fail("蓝牙权限已撤销"); }
    }
    private void fail(String message) {
        listener.state(message); close(); onFailure.run();
    }
    @Override public synchronized void close() {
        closed = true;
        if (advertiser != null && advertiseCallback != null) {
            try { advertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) {}
        }
        if (server != null) {
            for (BluetoothDevice device : connected)
                try { server.cancelConnection(device); } catch (Exception ignored) {}
            try { server.close(); } catch (Exception ignored) {}
            server = null;
        }
        subscribers.clear(); sending.clear(); connected.clear(); pending.clear();
        stream = null; advertiser = null; advertiseCallback = null;
    }
}
