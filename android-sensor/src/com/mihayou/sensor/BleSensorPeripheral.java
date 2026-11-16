package com.mihayou.sensor;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.ParcelUuid;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.UUID;

final class BleSensorPeripheral implements AutoCloseable {
    static final UUID SERVICE = UUID.fromString("f000aa00-0451-4000-b000-000000000000");
    static final UUID STREAM = UUID.fromString("f000aa01-0451-4000-b000-000000000000");
    interface Listener { void state(String message); }
    private final Context context;
    private final Listener listener;
    private BluetoothGattServer server;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattCharacteristic stream;
    private AdvertiseCallback advertiseCallback;

    BleSensorPeripheral(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }
    boolean start() {
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
                listener.state(state == 2 ? "电脑已通过蓝牙连接" : "等待电脑蓝牙连接");
            }
            @Override public void onDescriptorWriteRequest(BluetoothDevice device, int requestId,
                    android.bluetooth.BluetoothGattDescriptor descriptor, boolean preparedWrite,
                    boolean responseNeeded, int offset, byte[] value) {
                if (responseNeeded) server.sendResponse(device, requestId, 0, offset, value);
            }
        });
        BluetoothGattService service = new BluetoothGattService(SERVICE,
            BluetoothGattService.SERVICE_TYPE_PRIMARY);
        stream = new BluetoothGattCharacteristic(STREAM,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY | BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ);
        stream.addDescriptor(new android.bluetooth.BluetoothGattDescriptor(
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"),
            android.bluetooth.BluetoothGattDescriptor.PERMISSION_READ |
                android.bluetooth.BluetoothGattDescriptor.PERMISSION_WRITE));
        service.addCharacteristic(stream);
        server.addService(service);
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true).setTimeout(0).setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).build();
        AdvertiseData data = new AdvertiseData.Builder()
            .setIncludeDeviceName(false).addServiceUuid(new ParcelUuid(SERVICE)).build();
        advertiseCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings result) { listener.state("正在广播，等待电脑蓝牙连接"); }
            @Override public void onStartFailure(int errorCode) { listener.state("蓝牙广播失败：" + errorCode); }
        };
        advertiser.startAdvertising(settings, data, advertiseCallback);
        return true;
    }
    void publish(float x, float y, float z, long timestampNs) {
        if (server == null || stream == null) return;
        byte[] bytes = ByteBuffer.allocate(20).order(ByteOrder.LITTLE_ENDIAN)
            .putFloat(x).putFloat(y).putFloat(z).putLong(timestampNs).array();
        stream.setValue(bytes);
        for (BluetoothDevice device : server.getConnectedDevices()) {
            server.notifyCharacteristicChanged(device, stream, false);
        }
    }
    @Override public void close() {
        if (advertiser != null && advertiseCallback != null) {
            try { advertiser.stopAdvertising(advertiseCallback); } catch (Exception ignored) {}
        }
        if (server != null) { server.close(); server = null; }
        stream = null; advertiser = null; advertiseCallback = null;
    }
}
