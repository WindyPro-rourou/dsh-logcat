package dsh;

import android.hardware.input.InputManager;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Method;

/**
 * Long-lived input injector for the dsh-logcat panel.
 *
 * The stock `input` command starts a fresh app_process (Java VM) per invocation, which
 * costs ~480ms on this device — that is the latency the panel's touch controls suffer
 * from. This process boots once, then injects through the same InputManager API the
 * stock command uses, so each gesture costs only a few milliseconds.
 *
 * Protocol (stdin, one command per line; stdout answers "OK <ms>" or "ERR <why>"):
 *   tap <x> <y>
 *   swipe <x1> <y1> <x2> <y2> <ms>
 *   down <x> <y> | move <x> <y> | up <x> <y>
 *   key <keycode>
 *   ping
 */
public final class Injector {
    private static InputManager manager;
    private static Method injectMethod;
    private static final int MODE_ASYNC = 0;

    public static void main(String[] args) throws Exception {
        // app_process launches us in the platform domain, but be explicit: hidden-API
        // restrictions must not block InputManager.injectInputEvent.
        try {
            Class<?> vmRuntime = Class.forName("dalvik.system.VMRuntime");
            Object runtime = vmRuntime.getMethod("getRuntime").invoke(null);
            vmRuntime.getMethod("setHiddenApiExemptions", String[].class)
                    .invoke(runtime, (Object) new String[] { "L" });
        } catch (Throwable ignored) {
            // Older releases have no restrictions at all.
        }

        Class<?> cls = Class.forName("android.hardware.input.InputManager");
        manager = (InputManager) cls.getMethod("getInstance").invoke(null);
        injectMethod = cls.getMethod("injectInputEvent", InputEvent.class, int.class);

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        System.out.println("READY");
        System.out.flush();

        String line;
        while ((line = reader.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) {
                continue;
            }
            long started = SystemClock.uptimeMillis();
            try {
                handle(line.split("\\s+"));
                System.out.println("OK " + (SystemClock.uptimeMillis() - started));
            } catch (Throwable error) {
                System.out.println("ERR " + error);
            }
            System.out.flush();
        }
    }

    private static void handle(String[] p) throws Exception {
        String cmd = p[0];
        if ("ping".equals(cmd)) {
            return;
        }
        if ("key".equals(cmd)) {
            int code = Integer.parseInt(p[1]);
            long now = SystemClock.uptimeMillis();
            inject(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
            inject(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0));
            return;
        }
        if ("tap".equals(cmd)) {
            float x = Float.parseFloat(p[1]);
            float y = Float.parseFloat(p[2]);
            long down = SystemClock.uptimeMillis();
            motion(MotionEvent.ACTION_DOWN, x, y, down, down);
            sleep(40);
            motion(MotionEvent.ACTION_UP, x, y, down, SystemClock.uptimeMillis());
            return;
        }
        if ("down".equals(cmd) || "move".equals(cmd) || "up".equals(cmd)) {
            int action = "down".equals(cmd) ? MotionEvent.ACTION_DOWN
                    : "move".equals(cmd) ? MotionEvent.ACTION_MOVE : MotionEvent.ACTION_UP;
            float x = Float.parseFloat(p[1]);
            float y = Float.parseFloat(p[2]);
            long now = SystemClock.uptimeMillis();
            motion(action, x, y, downTime(action, now), now);
            return;
        }
        if ("swipe".equals(cmd)) {
            float x1 = Float.parseFloat(p[1]);
            float y1 = Float.parseFloat(p[2]);
            float x2 = Float.parseFloat(p[3]);
            float y2 = Float.parseFloat(p[4]);
            int duration = Math.max(1, Integer.parseInt(p[5]));
            long down = SystemClock.uptimeMillis();
            motion(MotionEvent.ACTION_DOWN, x1, y1, down, down);
            int steps = Math.max(6, duration / 12);
            for (int i = 1; i <= steps; i++) {
                long target = down + (long) duration * i / steps;
                long wait = target - SystemClock.uptimeMillis();
                if (wait > 0) {
                    sleep(wait);
                }
                motion(MotionEvent.ACTION_MOVE,
                        x1 + (x2 - x1) * i / steps,
                        y1 + (y2 - y1) * i / steps,
                        down, SystemClock.uptimeMillis());
            }
            motion(MotionEvent.ACTION_UP, x2, y2, down, SystemClock.uptimeMillis());
            return;
        }
        throw new IllegalArgumentException("unknown command: " + cmd);
    }

    /** A gesture keeps one downTime across all of its events. */
    private static long currentDown = 0;

    private static long downTime(int action, long now) {
        if (action == MotionEvent.ACTION_DOWN) {
            currentDown = now;
        }
        return currentDown == 0 ? now : currentDown;
    }

    private static void motion(int action, float x, float y, long downTime, long eventTime) throws Exception {
        MotionEvent event = MotionEvent.obtain(downTime, eventTime, action, x, y, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            inject(event);
        } finally {
            event.recycle();
        }
    }

    private static void inject(InputEvent event) throws Exception {
        injectMethod.invoke(manager, event, MODE_ASYNC);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
