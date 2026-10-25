package com.mihayou.linktest;

import java.util.ArrayList;
import java.util.List;

public final class SwingDetectorTest {
    private static int checks;
    private static final class Fixture implements SwingDetector.Listener {
        final List<String> actions = new ArrayList<>();
        final List<Double> times = new ArrayList<>();
        final List<String> states = new ArrayList<>();
        final SwingDetector detector = new SwingDetector(this);
        long time = 1000;
        Fixture(boolean calibrated) {
            if (calibrated) detector.restoreCalibration(0, 1, 0, 3, 7);
        }
        public void onState(String state) { states.add(state); }
        public void onAction(String action, double time, double peak) {
            actions.add(action); times.add(time);
        }
        void sample(double x, double y, double z) {
            detector.accept(x, y, z, time * 1_000_000L);
            time += 20;
        }
        void pulse(double y, int duration) {
            for (int i = 0; i < duration; i += 20) sample(0, y, 0);
        }
        void quiet(int duration) { pulse(0, duration); }
        void returnHome(int sign) {
            quiet(220); pulse(-sign * 2.0, 100); quiet(380);
        }
    }
    public static void main(String[] args) {
        Fixture calibration = new Fixture(false);
        calibration.pulse(8, 100);
        check(calibration.actions.isEmpty() && !calibration.detector.isCalibrated(),
            "no implicit calibration before user requests it");
        calibration.detector.beginCalibration();
        calibration.pulse(6, 80);
        calibration.pulse(-14, 100);
        calibration.returnHome(1);
        check(calibration.detector.isCalibrated(), "full calibration cycle completes");
        check(calibration.actions.isEmpty(), "calibration is not a gameplay input");
        check(calibration.detector.copyAxis()[1] > 0.99, "braking never flips learned direction");
        calibration.pulse(-6, 80);
        check(calibration.actions.equals(List.of("swing_down")), "opposite axis maps to down");

        Fixture pause = new Fixture(true);
        pause.pulse(6, 80);
        check(pause.actions.equals(List.of("swing_up")), "coherent stroke emits once");
        check(pause.times.get(0) == 1000, "event time is first threshold crossing, not confirmation time");
        pause.pulse(-6, 120);
        pause.quiet(2000);
        check(pause.actions.size() == 1 && pause.states.get(pause.states.size() - 1).contains("等待回正"),
            "braking and long endpoint pause do not rearm");
        pause.pulse(-6, 120);
        check(pause.actions.size() == 1, "return after long pause is not a down action");
        pause.quiet(160);
        pause.pulse(5, 80);
        check(pause.actions.size() == 1, "incomplete home stillness keeps lock");
        pause.quiet(380);
        pause.pulse(-6, 80);
        check(pause.actions.equals(List.of("swing_up", "swing_down")),
            "new down stroke accepted only after complete return");
        pause.returnHome(-1);
        pause.pulse(6, 80);
        check(pause.actions.equals(List.of("swing_up", "swing_down", "swing_up")),
            "both action directions use symmetric reset");

        Fixture noise = new Fixture(true);
        noise.sample(0, 15, 0); noise.quiet(400);
        check(noise.actions.isEmpty(), "one sample spike rejected");
        for (int i = 0; i < 10; i++) noise.sample(8, 0, 0);
        for (int i = 0; i < 10; i++) noise.sample(10, 4, 0);
        noise.pulse(2.9, 200);
        check(noise.actions.isEmpty(), "perpendicular and subthreshold activity rejected");
        for (int i = 0; i < 10; i++) noise.sample(0, i % 2 == 0 ? 8 : -8, 0);
        check(noise.actions.isEmpty(), "alternating noise cannot form coherent stroke");
        noise.detector.accept(Double.NaN, 8, 0, noise.time * 1_000_000L);
        check(noise.actions.isEmpty(), "nonfinite samples ignored");
        noise.detector.setThreshold(8);
        noise.pulse(6, 100);
        check(noise.actions.isEmpty(), "manual threshold affects classification");
        noise.detector.setThreshold(3);
        noise.pulse(6, 80);
        check(noise.actions.size() == 1, "manual sensitivity adjustment remains usable");
        noise.returnHome(1);

        Fixture gap = new Fixture(true);
        gap.sample(0, 6, 0);
        gap.time += 700;
        gap.sample(0, 6, 0);
        check(gap.actions.isEmpty(), "sample gap cannot satisfy candidate persistence");
        gap.pulse(6, 80);
        gap.quiet(220);
        gap.pulse(-2, 100);
        gap.time += 700;
        gap.quiet(1000);
        gap.pulse(-6, 80);
        check(gap.actions.size() == 1, "sampling interruption does not silently unlock");
        gap.detector.resetForStart();
        gap.pulse(-6, 80);
        check(gap.actions.size() == 2, "explicit reset recovers stalled detection");

        Fixture restored = new Fixture(false);
        restored.detector.restoreCalibration(Double.NaN, 1, 0, 3, 7);
        check(!restored.detector.isCalibrated(), "invalid saved axis rejected");
        restored.detector.restoreCalibration(1, 0, 0, 3, 7);
        restored.sample(6, 0, 0); restored.sample(6, 0, 0); restored.sample(6, 0, 0);
        check(restored.actions.equals(List.of("swing_up")), "calibration supports screen horizontal axis");
        System.out.println("SwingDetector: " + checks + " checks passed (synthetic 50 Hz traces)");
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
}
