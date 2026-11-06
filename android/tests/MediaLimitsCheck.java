package com.suikii.livephoto;
import java.io.IOException;
import java.util.Arrays;
public final class MediaLimitsCheck {
    interface Checked {void run() throws Exception;}
    static void rejected(Checked action) throws Exception {try{action.run();}catch(IOException expected){return;}throw new AssertionError("invalid media accepted");}
    public static void main(String[] args)throws Exception {
        MediaLimits.selection(3600000,3500000,3530000,3515000);
        MediaLimits.selection(60,0,60,30);
        rejected(()->MediaLimits.selection(100000,0,30001,1));
        rejected(()->MediaLimits.selection(100000,0,99,1));
        rejected(()->MediaLimits.selection(100000,0,30000,30001));
        rejected(()->MediaLimits.input(MediaLimits.INPUT_BYTES+1));
        rejected(()->MediaLimits.output(MediaLimits.OUTPUT_BYTES+1));
        if(!Arrays.equals(MediaLimits.outputSize(2160,3840),new int[]{1080,1920}))throw new AssertionError();
        if(!Arrays.equals(MediaLimits.outputSize(4000,4000),new int[]{1080,1080}))throw new AssertionError();
        System.out.println("ANDROID_LIMITS_OK: 30s/source boundaries, cover, input/output bytes and oriented dimensions");
    }
}
