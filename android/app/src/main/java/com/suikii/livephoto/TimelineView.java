package com.suikii.livephoto;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.View;
import java.util.List;
import java.util.Collections;

/** Filmstrip with two trim handles and a scrub position. */
final class TimelineView extends View {
    interface Listener { void onPosition(long time); void onRange(long start, long end); }
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float density;
    private Listener listener;
    private List<Bitmap> frames = Collections.emptyList();
    private long duration = 1, start, end = 1, position;
    private int target;
    private float anchorX;
    private long anchorTime,anchorEnd,viewStart;
    private boolean panning;
    private long span(){return Math.min(40000,duration);}
    TimelineView(Context context) { super(context); density=getResources().getDisplayMetrics().density; setFocusable(true); }
    void setListener(Listener value) { listener=value; }
    void setFrames(List<Bitmap> value) { frames=value; invalidate(); }
    void setRange(long total, long from, long to, long current) {
        if(!panning)viewStart=Math.max(0,Math.min(total-Math.min(40000,total),from-5000));
        duration=total; start=from; end=to; position=current;
        setContentDescription("视频时间线，选段 " + (from/1000.0) + " 到 " + (to/1000.0) + " 秒"); invalidate();
    }
    private float px(float dp) { return dp*density; }
    private float left() { return px(22); }
    private float width() { return Math.max(1,getWidth()-2*left()); }
    private float x(long time) { return left()+width()*(time-viewStart)/span(); }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float top=px(12), bottom=px(64), width=width();
        paint.setColor(Color.rgb(191,201,190)); canvas.drawRoundRect(left(),top,left()+width,bottom,px(5),px(5),paint);
        if (!frames.isEmpty()) {
            canvas.save(); canvas.clipRect(left(),top,left()+width,bottom);
            for (int i=0;i<frames.size();i++) {
                Bitmap frame=frames.get(i); float a=left()+width*i/frames.size(), b=left()+width*(i+1)/frames.size();
                float scale=Math.max((b-a)/frame.getWidth(),(bottom-top)/frame.getHeight());
                float w=frame.getWidth()*scale,h=frame.getHeight()*scale;
                canvas.save(); canvas.clipRect(a,top,b,bottom);
                canvas.drawBitmap(frame,null,new RectF((a+b-w)/2,(top+bottom-h)/2,(a+b+w)/2,(top+bottom+h)/2),paint);
                canvas.restore();
            } canvas.restore();
        }
        float a=x(start), b=x(end);
        paint.setColor(0xB8000000); canvas.drawRect(left(),top,a,bottom,paint); canvas.drawRect(b,top,left()+width,bottom,paint);
        paint.setColor(Color.WHITE); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(px(2));
        canvas.drawRect(a,top,b,bottom,paint); paint.setStyle(Paint.Style.FILL);
        canvas.drawRoundRect(a-px(8),top-px(2),a+px(2),bottom+px(2),px(3),px(3),paint);
        canvas.drawRoundRect(b-px(2),top-px(2),b+px(8),bottom+px(2),px(3),px(3),paint);
        paint.setColor(0xFF4A4A4A); canvas.drawRect(a-px(4),top+px(16),a-px(3),bottom-px(16),paint);
        canvas.drawRect(b+px(3),top+px(16),b+px(4),bottom-px(16),paint);
        paint.setColor(Color.WHITE); canvas.drawRect(x(position)-px(1),top-px(7),x(position)+px(1),bottom+px(8),paint);
    }
    @Override public boolean onTouchEvent(MotionEvent event) {
        if (listener==null || !isEnabled()) return false;
        if (event.getActionMasked()==MotionEvent.ACTION_DOWN) {
            float x=event.getX(), a=Math.abs(x-x(start)), b=Math.abs(x-x(end));
            target=Math.min(a,b)<px(24) ? (a<=b ? 1 : 2) : (x>x(start)&&x<x(end)?4:3); panning=true; anchorEnd=end;
            anchorX=x; anchorTime=target==1||target==4?start:target==2?end:viewStart+Math.round(Math.max(0,Math.min(1,(x-left())/width()))*span());
            getParent().requestDisallowInterceptTouchEvent(true); return true;
        }
        if (event.getActionMasked()==MotionEvent.ACTION_MOVE || event.getActionMasked()==MotionEvent.ACTION_UP) {
            long time=Math.max(0,Math.min(duration,anchorTime+Math.round((event.getX()-anchorX)/width()*span())));
            long min=Math.min(MediaLimits.MIN_LENGTH,duration);
            if (target==1) listener.onRange(Math.max(Math.max(0,end-MediaLimits.MAX_LENGTH),Math.min(time,end-min)),end);
            else if (target==2) listener.onRange(start,Math.min(Math.min(duration,start+MediaLimits.MAX_LENGTH),Math.max(time,start+min)));
            else if(target==4){long next=Math.max(0,Math.min(duration-(anchorEnd-anchorTime),time));listener.onRange(next,next+anchorEnd-anchorTime);}
            else listener.onPosition(time);
            if (event.getActionMasked()==MotionEvent.ACTION_UP) { panning=false; performClick(); getParent().requestDisallowInterceptTouchEvent(false); }
            return true;
        }
        if (event.getActionMasked()==MotionEvent.ACTION_CANCEL) { panning=false; getParent().requestDisallowInterceptTouchEvent(false); return true; }
        return false;
    }
    @Override public boolean performClick() { super.performClick(); return true; }
}
