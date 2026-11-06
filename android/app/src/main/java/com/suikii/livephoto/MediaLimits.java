package com.suikii.livephoto;

import java.io.File;
import java.io.IOException;

final class MediaLimits {
    private static boolean started;
    static synchronized void startup(File directory) {
        if(started)return; started=true;
        File[] files=directory.listFiles(); if(files==null)return;
        for(File file:files)if(file.getName().startsWith("source-")||file.getName().startsWith("prepared-"))remove(file);
    }
    private static void remove(File file) { File[] files=file.listFiles();if(files!=null)for(File child:files)remove(child);file.delete(); }
    static final long MAX_LENGTH=30000, MIN_LENGTH=100, DEFAULT_LENGTH=3000;
    static final long INPUT_BYTES=1L<<30, OUTPUT_BYTES=50L<<20, WORK_BYTES=256L<<20, RESERVE_BYTES=512L<<20;
    static void input(long bytes) throws IOException { if(bytes>INPUT_BYTES) throw new IOException("原视频超过 1 GiB，请先裁剪素材"); }
    static void space(File directory,long additional) throws IOException { if(directory.getUsableSpace()<additional+RESERVE_BYTES) throw new IOException("手机空间不足，请释放空间后重试"); }
    static void output(long bytes) throws IOException { if(bytes>OUTPUT_BYTES) throw new IOException("成片超过 50 MiB，请缩短片段"); }
    static void selection(long duration,long start,long end,long cover) throws IOException {
        if(duration<=0 || start<0 || end>duration || end-start<Math.min(MIN_LENGTH,duration) || end-start>MAX_LENGTH || cover<start || cover>end)
            throw new IOException("选段必须在视频内，最长 30 秒");
    }
    static int[] outputSize(int width,int height) {
        if(width<2||height<2)throw new IllegalArgumentException("视频尺寸太小");
        double scale=Math.min(1,Math.min(1920.0/Math.max(width,height),1080.0/Math.min(width,height)));
        return new int[]{(int)(width*scale/2)*2,(int)(height*scale/2)*2};
    }
}
