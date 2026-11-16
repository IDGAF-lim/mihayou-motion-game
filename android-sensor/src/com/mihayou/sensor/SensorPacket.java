package com.mihayou.sensor;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public final class SensorPacket {
    public static final int ACCELERATION = 1, ROTATION = 2;
    public static byte[] encode(int kind, int sequence, long timestampNs, float x, float y, float z) {
        if (kind != ACCELERATION && kind != ROTATION) throw new IllegalArgumentException("Unknown sensor kind");
        return ByteBuffer.allocate(20).order(ByteOrder.LITTLE_ENDIAN)
            .put((byte) 1).put((byte) kind).putShort((short) sequence)
            .putInt((int) (timestampNs / 1_000_000L)).putFloat(x).putFloat(y).putFloat(z).array();
    }
    private SensorPacket() {}
}
