package com.mihayou.sensor;

// Recovered from the user-supplied com.mihayou.sensor 0.4.9 APK.
public final class PoseFrame {
    public static void project(float[] reference, float[] rotation, float[] input,
                               float[] output, float[] angles) {
        float x = rotation[0] * input[0] + rotation[1] * input[1] + rotation[2] * input[2];
        float y = rotation[3] * input[0] + rotation[4] * input[1] + rotation[5] * input[2];
        float z = rotation[6] * input[0] + rotation[7] * input[1] + rotation[8] * input[2] - 9.80665f;
        for (int i = 0; i < 3; i++) {
            output[i] = reference[i] * x + reference[i + 3] * y + reference[i + 6] * z;
        }
        float a = 0, b = 0, c = 0, d = 0, e = 0;
        for (int i = 0; i < 3; i++) {
            int row = i * 3;
            a += reference[row] * rotation[row];
            b += reference[row + 1] * rotation[row];
            c += reference[row + 2] * rotation[row];
            d += reference[row + 2] * rotation[row + 1];
            e += reference[row + 2] * rotation[row + 2];
        }
        angles[0] = (float) Math.toDegrees(Math.atan2(-c, Math.sqrt(a * a + b * b)));
        angles[1] = (float) Math.toDegrees(Math.atan2(d, e));
        angles[2] = (float) Math.toDegrees(Math.atan2(b, a));
    }
    private PoseFrame() {}
}
