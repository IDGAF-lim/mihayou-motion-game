package com.mihayou.linktest;

public final class SwingDetector {
    public interface Listener {
        void onState(String state);
        void onAction(String action, double sensorTimeMs, double peak);
    }

    private static final double MIN_CALIBRATION_PEAK = 4.0;
    private static final double RESET_ACTIVITY = 1.8;
    private static final double MIN_THRESHOLD = 2.0;
    private static final double MAX_THRESHOLD = 8.0;
    private static final long CANDIDATE_MS = 30;
    private static final long ENDPOINT_QUIET_MS = 140;
    private static final long HOME_QUIET_MS = 300;
    private static final int READY = 0, OUTBOUND = 1, WAIT_RETURN = 2, RETURNING = 3;

    private final Listener listener;
    private final double[] axis = new double[3];
    private final double[] candidateAxis = new double[3];
    private boolean calibrated, calibrationRequested, calibrationInProgress;
    private int phase = READY, strokeSign, candidateSign, candidateSamples;
    private double threshold = 3.2, calibrationPeak, candidatePeak, candidateTimeMs;
    private long lastTime, candidateStart = -1, quietStart = -1, returnStart = -1;

    public SwingDetector(Listener listener) {
        this.listener = listener;
    }

    public boolean isCalibrated() { return calibrated; }
    public double getThreshold() { return threshold; }
    public double getCalibrationPeak() { return calibrationPeak; }
    public double[] copyAxis() { return new double[] { axis[0], axis[1], axis[2] }; }

    public void setThreshold(double value) {
        if (Double.isFinite(value)) threshold = clamp(value, MIN_THRESHOLD, MAX_THRESHOLD);
        clearCandidate();
    }

    public void restoreCalibration(double x, double y, double z, double savedThreshold, double peak) {
        double norm = magnitude(x, y, z);
        if (!Double.isFinite(norm) || norm < 0.8 || !Double.isFinite(savedThreshold) || savedThreshold < MIN_THRESHOLD ||
            savedThreshold > MAX_THRESHOLD) return;
        axis[0] = x / norm; axis[1] = y / norm; axis[2] = z / norm;
        threshold = savedThreshold;
        calibrationPeak = Double.isFinite(peak) ? Math.max(0, peak) : 0;
        calibrated = true;
        resetForStart();
    }

    public void beginCalibration() {
        calibrated = false;
        calibrationRequested = true;
        calibrationInProgress = false;
        calibrationPeak = 0;
        resetForStart();
        announceReady();
    }

    public void resetForStart() {
        lastTime = 0; phase = READY; quietStart = -1; returnStart = -1;
        calibrationInProgress = false;
        clearCandidate();
    }

    public void announceReady() {
        listener.onState(calibrated ? "已就绪" :
            calibrationRequested ? "等待校准上挥" : "未校准");
    }

    public void accept(double x, double y, double z, long timestampNs) {
        if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) return;
        long now = timestampNs / 1_000_000L;
        if (lastTime > 0 && now <= lastTime) return;
        if (lastTime > 0 && now - lastTime > 100) {
            clearCandidate(); quietStart = -1; returnStart = -1;
        }
        if (lastTime > 0 && now - lastTime > 500) {
            clearCandidate(); quietStart = -1; returnStart = -1;
            // A sampling interruption is not evidence of stillness or return.
            if (phase != READY) {
                phase = OUTBOUND;
                listener.onState("采样中断 · 等待末端停稳");
            }
        }
        lastTime = now;
        double strength = magnitude(x, y, z);
        double projected = x * axis[0] + y * axis[1] + z * axis[2];
        if (phase != READY) {
            updateReturn(now, strength, projected);
            return;
        }
        if (!calibrated && !calibrationRequested) return;
        double required = calibrated ? threshold : MIN_CALIBRATION_PEAK;
        double along = calibrated ? Math.abs(projected) : strength;
        int sign = calibrated && projected < 0 ? -1 : 1;
        boolean aligned = calibrated ? along >= strength * 0.7 :
            candidateStart < 0 || (x * candidateAxis[0] + y * candidateAxis[1] +
                z * candidateAxis[2]) >= strength * 0.8;
        if (along < required || !aligned) { clearCandidate(); return; }
        if (candidateStart < 0 || candidateSign != sign) {
            candidateStart = now; candidateSign = sign; candidateSamples = 0;
            candidatePeak = 0; candidateTimeMs = timestampNs / 1_000_000.0;
            candidateAxis[0] = x / strength; candidateAxis[1] = y / strength;
            candidateAxis[2] = z / strength;
        }
        candidateSamples++;
        candidatePeak = Math.max(candidatePeak, along);
        if (now - candidateStart < CANDIDATE_MS || candidateSamples < 2) return;
        strokeSign = sign; phase = OUTBOUND; quietStart = -1; returnStart = -1;
        if (!calibrated) {
            System.arraycopy(candidateAxis, 0, axis, 0, 3);
            calibrationPeak = candidatePeak;
            threshold = clamp(calibrationPeak * 0.45, 2.8, 6.0);
            calibrationInProgress = true;
            listener.onState("已记录方向 · 等待末端停稳");
        } else {
            listener.onAction(sign > 0 ? "swing_up" : "swing_down", candidateTimeMs, candidatePeak);
            listener.onState((sign > 0 ? "上挥" : "下挥") + "已识别 · 等待末端停稳");
        }
        clearCandidate();
    }

    private void updateReturn(long now, double strength, double projected) {
        if (phase == OUTBOUND) {
            if (strength > RESET_ACTIVITY) { quietStart = -1; return; }
            if (quietStart < 0) quietStart = now;
            if (now - quietStart >= ENDPOINT_QUIET_MS) {
                phase = WAIT_RETURN; quietStart = -1;
                listener.onState("已停稳 · 等待回正");
            }
        } else if (phase == WAIT_RETURN) {
            // Braking before the endpoint pause is deliberately not a return.
            double returnThreshold = Math.max(0.8, threshold * 0.28);
            if (-strokeSign * projected < returnThreshold ||
                Math.abs(projected) < strength * 0.5) { returnStart = -1; return; }
            if (returnStart < 0) returnStart = now;
            if (now - returnStart >= 40) {
                phase = RETURNING; quietStart = -1;
                listener.onState("回正中 · 等待停稳");
            }
        } else if (phase == RETURNING) {
            if (strength > RESET_ACTIVITY) { quietStart = -1; return; }
            if (quietStart < 0) quietStart = now;
            if (now - quietStart < HOME_QUIET_MS) return;
            phase = READY; clearCandidate();
            if (calibrationInProgress) {
                calibrationInProgress = false; calibrationRequested = false; calibrated = true;
                listener.onState("校准完成 · 已就绪");
            } else listener.onState("已就绪");
        }
    }

    private void clearCandidate() {
        candidateStart = -1; candidateSamples = 0; candidatePeak = 0;
    }
    private static double magnitude(double x, double y, double z) {
        return Math.sqrt(x * x + y * y + z * z);
    }

    private static double clamp(double value, double low, double high) {
        return Math.max(low, Math.min(high, value));
    }
}
