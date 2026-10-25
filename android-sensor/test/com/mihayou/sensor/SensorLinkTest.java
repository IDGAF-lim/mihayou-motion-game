package com.mihayou.sensor;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class SensorLinkTest {
    private static double now() { return System.nanoTime() / 1_000_000.0; }
    public static void main(String[] args) throws Exception {
        float[] identity = {1,0,0,0,1,0,0,0,1}, output = new float[3], angles = new float[3];
        PoseFrame.project(identity, identity, new float[] {2,3,9.80665f}, output, angles);
        if (Math.abs(output[0]-2)>.001 || Math.abs(output[1]-3)>.001 || Math.abs(output[2])>.001)
            throw new AssertionError("original pose projection");
        CountDownLatch ready = new CountDownLatch(1);
        AtomicInteger sent = new AtomicInteger(), dropped = new AtomicInteger();
        try (SensorLink link = new SensorLink("native-integration", "JVM transport fixture", SensorLinkTest::now,
            new SensorLink.Listener() {
                public void state(boolean connected, String text, double rtt) {
                    if (connected && Double.isFinite(rtt) && rtt >= 0) ready.countDown();
                }
                public void action(String text) {
                    if (text.contains("已发出")) sent.incrementAndGet();
                    if (text.contains("过期") || text.contains("未连接")) dropped.incrementAndGet();
                }
            })) {
            link.connect(args[0]);
            if (!ready.await(7, TimeUnit.SECONDS)) throw new AssertionError("no measured RTT and socket readiness");
            link.send("java-session", 1, "swing_up", now(), false);
            link.send("java-session", 2, "swing_down", now()-1000, false);
            link.send("java-session", 3, "swing_down", now(), true);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
            while ((sent.get() < 2 || dropped.get() < 1) && System.nanoTime() < deadline) Thread.sleep(10);
            if (sent.get()!=2 || dropped.get()!=1) throw new AssertionError("send/drop accounting");
            Thread.sleep(1300);
            link.disconnect();
            link.send("java-session", 4, "swing_up", now(), false);
            if (dropped.get()!=2) throw new AssertionError("disconnect must drop actions");
            System.out.println("native transport: synchronized RTT, 2 sends, expired/offline drops; pose projection passed");
        }
    }
}
