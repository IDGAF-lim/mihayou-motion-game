package com.mihayou.sensor;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public final class SensorPacketTest {
    public static void main(String[] args) {
        byte[] bytes = SensorPacket.encode(2, 65537, 4_294_967_310_000_000L, 1.25f, -2.5f, 3.75f);
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        if (bytes.length != 20 || b.get() != 1 || b.get() != 2 ||
            (b.getShort() & 65535) != 1 || Integer.toUnsignedLong(b.getInt()) != 14 ||
            b.getFloat() != 1.25f || b.getFloat() != -2.5f || b.getFloat() != 3.75f)
            throw new AssertionError("Wire packet layout mismatch");
        System.out.println("SensorPacket: 20-byte little-endian layout and counter wrap passed");
    }
}
