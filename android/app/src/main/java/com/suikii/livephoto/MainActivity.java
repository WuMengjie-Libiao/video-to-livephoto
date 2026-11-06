package com.suikii.livephoto;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.VideoView;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.effect.Presentation;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.Transformer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import com.google.common.collect.ImmutableList;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressLint("UnsafeOptInUsageError")
public final class MainActivity extends Activity {
    private static final int PICK_VIDEO = 42;
    private static final int BG = 0xFFF7F7F4, TEXT = 0xFF29352E, MUTED = 0xFF626B61, ACCENT = 0xFF34578C;
    private static final String[] ASPECT_LABELS = {"原比例", "1:1", "9:16", "16:9", "3:4"};
    private static final float[] ASPECT_VALUES = {0, 1, 9f/16, 16f/9, 3f/4};
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<Bitmap> frames = new ArrayList<>();
    private LinearLayout root, editor, footer, header;
    private TextView timeLabel, durationLabel, soundButton, aspectButton, actionButton;
    private Button coverButton, playButton, importButton;
    private TimelineView timeline;
    private VideoFrame videoFrame;
    private PlayerView videoView;
    private ExoPlayer player;
    private Transformer transformer;
    private File source, preparedDir;
    private long duration, start, end, position, cover;
    private float sourceAspect = 1;
    private int aspectIndex;
    private boolean mute, busy, closed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        player = new ExoPlayer.Builder(this).build();
        buildLayout();
        handler.post(tick);
    }
    private int dp(float x) { return Math.round(getResources().getDisplayMetrics().density*x); }
    private TextView text(String value, int sp, int color) {
        TextView t = new TextView(this); t.setText(value); t.setTextSize(sp); t.setTextColor(color); t.setGravity(Gravity.CENTER_VERTICAL); return t;
    }
    private Button button(String label, Runnable action) {
        Button b=new Button(this); b.setText(label); b.setTextColor(ACCENT); b.setTextSize(14); b.setAllCaps(false);
        b.setBackgroundColor(Color.TRANSPARENT); b.setMinHeight(dp(48)); b.setOnClickListener(v -> action.run()); return b;
    }
    private void buildLayout() {
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(BG);
        header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(dp(16),0,dp(12),0);
        TextView title=text("实况照片",17,TEXT); title.setTypeface(null,1); header.addView(title,new LinearLayout.LayoutParams(0,dp(52),1));
        importButton=button("选择视频",this::pick); header.addView(importButton);
        actionButton=text("预览",14,ACCENT); actionButton.setGravity(Gravity.CENTER); actionButton.setPadding(dp(12),0,dp(12),0);
        actionButton.setOnClickListener(v -> prepare()); actionButton.setVisibility(View.GONE); header.addView(actionButton,new LinearLayout.LayoutParams(-2,dp(48)));
        root.addView(header); editor=new LinearLayout(this); editor.setOrientation(LinearLayout.VERTICAL); editor.setPadding(dp(16),0,dp(16),0);
        editor.setVisibility(View.GONE); root.addView(editor,new LinearLayout.LayoutParams(-1,0,1));
        videoFrame=new VideoFrame(this); videoFrame.setBackgroundColor(Color.BLACK);
        videoView=new PlayerView(this); videoView.setUseController(false); videoView.setPlayer(player); videoView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_ZOOM);
        videoView.setOnClickListener(v -> togglePlay()); videoFrame.addView(videoView); editor.addView(videoFrame,new LinearLayout.LayoutParams(-1,0,4));
        LinearLayout controls=new LinearLayout(this); controls.setGravity(Gravity.CENTER_VERTICAL);
        timeLabel=text("0:00 / 0:00",12,MUTED); controls.addView(timeLabel,new LinearLayout.LayoutParams(0,dp(48),1));
        playButton=button("播放",this::togglePlay); controls.addView(playButton); editor.addView(controls);
        timeline=new TimelineView(this); editor.addView(timeline,new LinearLayout.LayoutParams(-1,dp(84)));
        timeline.setListener(new TimelineView.Listener() {
            public void onPosition(long value) { pause(); seek(value); }
            public void onRange(long from,long to) { boolean startChanged = from != start; pause(); start=from; end=to; cover=Math.max(start,Math.min(end,cover)); seek(startChanged ? from : to); refresh(); }
        });
        durationLabel=text("",12,MUTED); durationLabel.setGravity(Gravity.CENTER); editor.addView(durationLabel,new LinearLayout.LayoutParams(-1,dp(28)));
        View spacer=new View(this); editor.addView(spacer,new LinearLayout.LayoutParams(-1,0,1));
        footer=new LinearLayout(this); footer.setGravity(Gravity.CENTER); footer.setPadding(dp(8),0,dp(8),dp(6)); footer.setVisibility(View.GONE);
        coverButton=button("设为封面", () -> { if(position>=start && position<=end) { cover=position; toast("已设为封面"); } });
        footer.addView(coverButton,new LinearLayout.LayoutParams(0,dp(52),1));
        aspectButton=button("原比例",this::selectAspect); footer.addView(aspectButton,new LinearLayout.LayoutParams(0,dp(52),1));
        soundButton=button("保留声音", () -> { mute=!mute; player.setVolume(mute?0:1); refresh(); }); footer.addView(soundButton,new LinearLayout.LayoutParams(0,dp(52),1));
        root.addView(footer); setContentView(root);
    }
    private void pick() {
        if (busy) return;
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("video/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent,PICK_VIDEO);
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request!=PICK_VIDEO || result!=RESULT_OK || data==null || data.getData()==null) return;
        setBusy(true); Uri uri=data.getData();
        worker.execute(() -> {
            File tmp=null; List<Bitmap> thumbnails=new ArrayList<>();
            try {
                tmp=File.createTempFile("source-", ".video",getCacheDir());
                try(InputStream in=getContentResolver().openInputStream(uri); OutputStream out=new FileOutputStream(tmp)) {
                    if(in==null) throw new IOException("无法打开所选视频"); copy(in,out);
                }
                MediaMetadataRetriever reader=new MediaMetadataRetriever();
                long length; float ratio;
                try {
                    reader.setDataSource(tmp.getAbsolutePath());
                    length=Long.parseLong(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                    int width=Integer.parseInt(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
                    int height=Integer.parseInt(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
                    String rotationValue=reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                    int rotation=rotationValue == null ? 0 : Integer.parseInt(rotationValue);
                    if (length<=0 || width<=0 || height<=0) throw new IOException("视频没有可用画面");
                    ratio=rotation%180==0 ? (float)width/height : (float)height/width;
                    for(int i=0;i<8;i++) {
                        Bitmap frame=reader.getScaledFrameAtTime(length*1000L*(2*i+1)/16,MediaMetadataRetriever.OPTION_CLOSEST,160,160);
                        if(frame!=null) thumbnails.add(frame);
                    }
                } finally { reader.release(); }
                File ready=tmp; tmp=null;
                runOnUiThread(() -> {
                    if(closed) { ready.delete(); return; }
                    player.stop(); player.clearMediaItems(); if(source!=null) source.delete(); source=ready;
                    frames.clear(); frames.addAll(thumbnails); timeline.setFrames(frames);
                    duration=length; start=0; end=Math.min(3000,length); position=0; cover=end/2; sourceAspect=ratio; aspectIndex=0;
                    player.setMediaItem(MediaItem.fromUri(Uri.fromFile(source))); player.prepare(); player.setVolume(mute?0:1);
                    videoFrame.setAspect(sourceAspect); editor.setVisibility(View.VISIBLE); footer.setVisibility(View.VISIBLE);
                    actionButton.setVisibility(View.VISIBLE); importButton.setText("换视频"); setBusy(false); refresh();
                });
            } catch(Exception error) {
                if(tmp!=null) tmp.delete();
                runOnUiThread(() -> { if(!closed) { setBusy(false); showError("视频打开失败",error); } });
            }
        });
    }
    private void selectAspect() {
        if(busy) return;
        new AlertDialog.Builder(this).setTitle("画面比例").setSingleChoiceItems(ASPECT_LABELS,aspectIndex,(dialog,which) -> {
            aspectIndex=which; videoFrame.setAspect(which==0?sourceAspect:ASPECT_VALUES[which]); refresh(); dialog.dismiss();
        }).setNegativeButton("取消",null).show();
    }
    private void refresh() {
        timeLabel.setText(String.format(Locale.ROOT,"%s / %s",time(position),time(duration)));
        durationLabel.setText(String.format(Locale.ROOT,"%s                         %.1f 秒                         %s",time(start),(end-start)/1000.0,time(end)));
        aspectButton.setText(ASPECT_LABELS[aspectIndex]); soundButton.setText(mute?"声音已关":"保留声音");
        coverButton.setEnabled(!busy && position>=start && position<=end); timeline.setRange(duration,start,end,position);
        playButton.setText(player.isPlaying()?"暂停":"播放");
    }
    private static String time(long value) { return String.format(Locale.ROOT,"%d:%04.1f",value/60000,(value%60000)/1000.0); }
    private void seek(long value) { position=Math.max(0,Math.min(duration,value)); player.seekTo(position); refresh(); }
    private void pause() { player.pause(); }
    private void togglePlay() {
        if(busy || source==null) return;
        if(player.isPlaying()) pause();
        else { if(position<start || position>=end-20) seek(start); player.play(); }
        refresh();
    }
    private final Runnable tick=new Runnable() {
        public void run() {
            if(closed) return;
            if(player.isPlaying()) { position=player.getCurrentPosition(); if(position>=end) { pause(); seek(end); } else refresh(); }
            handler.postDelayed(this,100);
        }
    };
    private void setBusy(boolean value) {
        busy=value; importButton.setEnabled(!value); actionButton.setEnabled(!value); playButton.setEnabled(!value);
        aspectButton.setEnabled(!value); soundButton.setEnabled(!value); timeline.setEnabled(!value); coverButton.setEnabled(!value);
        actionButton.setText(value?"准备中…":"预览");
    }
    private void prepare() {
        if(busy || source==null) return;
        pause(); setBusy(true);
        final long selectedStart=start, selectedEnd=end, selectedCover=cover;
        final boolean silent=mute; final int selectedAspect=aspectIndex;
        try {
            File directory=new File(getCacheDir(),"prepared-"+java.util.UUID.randomUUID());
            if(!directory.mkdir()) throw new IOException("无法创建临时目录");
            preparedDir=directory;
            File clip=new File(directory,"clip.mp4");
            MediaItem media=new MediaItem.Builder().setUri(Uri.fromFile(source)).setClippingConfiguration(
                new MediaItem.ClippingConfiguration.Builder().setStartPositionMs(selectedStart).setEndPositionMs(selectedEnd).build()).build();
            EditedMediaItem.Builder edit=new EditedMediaItem.Builder(media).setRemoveAudio(silent);
            if(selectedAspect!=0) edit.setEffects(new Effects(ImmutableList.of(),ImmutableList.of(
                Presentation.createForAspectRatio(ASPECT_VALUES[selectedAspect],Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP))));
            transformer=new Transformer.Builder(this).setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC)
                .addListener(new Transformer.Listener() {
                    @Override public void onCompleted(Composition composition, ExportResult result) {
                        transformer=null;
                        worker.execute(() -> buildStillAndPreview(directory,clip,selectedCover-selectedStart,selectedEnd-selectedStart,silent));
                    }
                    @Override public void onError(Composition composition, ExportResult result, ExportException error) {
                        transformer=null; clean(directory); preparedDir=null; setBusy(false); showError("视频生成失败",error);
                    }
                }).build();
            transformer.start(edit.build(),clip.getAbsolutePath());
        } catch(Exception error) { clean(preparedDir); preparedDir=null; setBusy(false); showError("视频生成失败",error); }
    }
    private void buildStillAndPreview(File dir,File clip,long coverMs,long length,boolean silent) {
        try {
            MediaMetadataRetriever reader=new MediaMetadataRetriever(); Bitmap frame;
            try {
                reader.setDataSource(clip.getAbsolutePath());
                long actual=Long.parseLong(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                coverMs=Math.max(0,Math.min(coverMs,Math.max(0,actual-50)));
                frame=reader.getFrameAtTime(coverMs*1000,MediaMetadataRetriever.OPTION_CLOSEST);
            } finally { reader.release(); }
            if(frame==null) throw new IOException("无法从成片提取封面");
            File still=new File(dir,"cover.jpg"), motion=new File(dir,"photo.MP.JPG");
            try(OutputStream stream=new FileOutputStream(still)) { if(!frame.compress(Bitmap.CompressFormat.JPEG,95,stream)) throw new IOException("无法生成封面"); }
            MotionPhoto.write(still,clip,motion,coverMs*1000);
            runOnUiThread(() -> { if(closed) { clean(dir); return; } setBusy(false); showPreview(dir,clip,still,motion,length,silent); });
        } catch(Exception error) {
            clean(dir); runOnUiThread(() -> { if(!closed) { preparedDir=null; setBusy(false); showError("预览生成失败",error); } });
        }
    }
    private void showPreview(File dir,File clip,File still,File motion,long length,boolean silent) {
        LinearLayout content=new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(12),0,dp(12),0);
        FrameLayout canvas=new FrameLayout(this); canvas.setBackgroundColor(Color.BLACK);
        VideoView video=new VideoView(this); ImageView coverView=new ImageView(this);
        coverView.setImageURI(Uri.fromFile(still)); coverView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        canvas.addView(video,new FrameLayout.LayoutParams(-1,-1)); canvas.addView(coverView,new FrameLayout.LayoutParams(-1,-1));
        canvas.setOnClickListener(v -> { coverView.setVisibility(View.GONE); video.start(); });
        video.setOnCompletionListener(p -> coverView.setVisibility(View.VISIBLE));
        content.addView(canvas,new LinearLayout.LayoutParams(-1,dp(320)));
        TextView hint=text(String.format(Locale.ROOT,"点击画面播放 · %.1f 秒 · %s",length/1000.0,silent?"无声音":"保留声音"),13,MUTED);
        hint.setGravity(Gravity.CENTER); content.addView(hint,new LinearLayout.LayoutParams(-1,dp(52)));
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("预览效果").setView(content).setNegativeButton("返回调整",null).setPositiveButton("保存到相册",null).create();
        dialog.setOnDismissListener(d -> { video.stopPlayback(); clean(dir); if(preparedDir==dir) preparedDir=null; });
        dialog.setOnShowListener(d -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            video.setOnPreparedListener(p -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true));
            video.setOnErrorListener((p,what,extra) -> {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                hint.setText("成片无法播放，请返回重试"); return true;
            });
            video.setVideoURI(Uri.fromFile(clip));
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            dialog.setCancelable(false); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false); dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false);
            hint.setText("正在保存…");
            worker.execute(() -> {
                try {
                    saveMotion(motion);
                    runOnUiThread(() -> { if(!closed) { dialog.dismiss(); toast("已保存到相册"); } });
                } catch(Exception error) {
                    runOnUiThread(() -> { if(!closed) { dialog.setCancelable(true); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true); hint.setText("保存失败，请重试"); showError("保存失败",error); } });
                }
            });
            });
        });
        dialog.show();
    }
    private void saveMotion(File file) throws IOException {
        ContentValues values=new ContentValues(); values.put(MediaStore.Images.Media.DISPLAY_NAME,"LivePhoto_"+System.currentTimeMillis()+".MP.JPG");
        values.put(MediaStore.Images.Media.MIME_TYPE,"image/jpeg"); values.put(MediaStore.Images.Media.RELATIVE_PATH,Environment.DIRECTORY_PICTURES+"/LivePhoto"); values.put(MediaStore.Images.Media.IS_PENDING,1);
        Uri uri=getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);
        if(uri==null) throw new IOException("相册无法创建照片");
        try {
            try(InputStream in=new FileInputStream(file); OutputStream out=getContentResolver().openOutputStream(uri)) {
                if(out==null) throw new IOException("相册无法写入照片"); copy(in,out);
            }
            ContentValues done=new ContentValues(); done.put(MediaStore.Images.Media.IS_PENDING,0);
            if(getContentResolver().update(uri,done,null,null)!=1) throw new IOException("相册未完成保存");
        } catch(IOException | RuntimeException error) { getContentResolver().delete(uri,null,null); throw error; }
    }
    private static void copy(InputStream in,OutputStream out) throws IOException { byte[] data=new byte[65536]; int n; while((n=in.read(data))!=-1) out.write(data,0,n); }
    private static void clean(File dir) { if(dir==null)return; File[] files=dir.listFiles(); if(files!=null) for(File f:files) f.delete(); dir.delete(); }
    private void toast(String value) { Toast.makeText(this,value,Toast.LENGTH_SHORT).show(); }
    private void showError(String title,Exception error) { new AlertDialog.Builder(this).setTitle(title).setMessage(error.getLocalizedMessage()).setPositiveButton("知道了",null).show(); }
    @Override protected void onPause() { super.onPause(); pause(); }
    @Override protected void onDestroy() { closed=true; handler.removeCallbacks(tick); if(transformer!=null) transformer.cancel(); player.release(); worker.shutdown(); if(source!=null) source.delete(); clean(preparedDir); super.onDestroy(); }

    /** Fits an aspect-ratio frame inside the available preview without stretching. */
    private static final class VideoFrame extends FrameLayout {
        private float aspect=1;
        VideoFrame(Activity context) { super(context); }
        void setAspect(float value) { aspect=value; requestLayout(); }
        @Override protected void onMeasure(int widthSpec,int heightSpec) {
            super.onMeasure(widthSpec,heightSpec);
            int w=getMeasuredWidth(),h=getMeasuredHeight();
            int cw=Math.min(w,Math.round(h*aspect)), ch=Math.min(h,Math.round(w/aspect));
            if(getChildCount()>0) getChildAt(0).measure(MeasureSpec.makeMeasureSpec(cw,MeasureSpec.EXACTLY),MeasureSpec.makeMeasureSpec(ch,MeasureSpec.EXACTLY));
        }
        @Override protected void onLayout(boolean changed,int l,int t,int r,int b) {
            if(getChildCount()==0)return; View child=getChildAt(0); int x=(r-l-child.getMeasuredWidth())/2,y=(b-t-child.getMeasuredHeight())/2;
            child.layout(x,y,x+child.getMeasuredWidth(),y+child.getMeasuredHeight());
        }
    }
}
