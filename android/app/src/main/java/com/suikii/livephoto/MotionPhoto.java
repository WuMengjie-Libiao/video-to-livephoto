package com.suikii.livephoto;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** A JPEG primary image followed by an MP4, with a Google Motion Photo directory. */
public final class MotionPhoto {
    private static final byte[] XMP = "http://ns.adobe.com/xap/1.0/\0".getBytes(StandardCharsets.UTF_8);
    private MotionPhoto() {}

    public static void write(File still, File video, File output, long coverTimeUs) throws IOException {
        if (coverTimeUs < 0 || video.length() < 12) throw new IOException("无效的实况视频或封面时间");
        String xml = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">"
            + "<rdf:Description rdf:about=\"\" xmlns:GCamera=\"http://ns.google.com/photos/1.0/camera/\""
            + " xmlns:Container=\"http://ns.google.com/photos/1.0/container/\" xmlns:Item=\"http://ns.google.com/photos/1.0/container/item/\""
            + " GCamera:MotionPhoto=\"1\" GCamera:MotionPhotoVersion=\"1\" GCamera:MotionPhotoPresentationTimestampUs=\"" + coverTimeUs + "\""
            + " GCamera:MicroVideo=\"1\" GCamera:MicroVideoVersion=\"1\" GCamera:MicroVideoOffset=\"" + video.length() + "\""
            + " GCamera:MicroVideoPresentationTimestampUs=\"" + coverTimeUs + "\">"
            + "<Container:Directory><rdf:Seq>"
            + "<rdf:li rdf:parseType=\"Resource\"><Container:Item Item:Mime=\"image/jpeg\" Item:Semantic=\"Primary\" Item:Length=\"0\" Item:Padding=\"0\"/></rdf:li>"
            + "<rdf:li rdf:parseType=\"Resource\"><Container:Item Item:Mime=\"video/mp4\" Item:Semantic=\"MotionPhoto\" Item:Length=\"" + video.length() + "\"/></rdf:li>"
            + "</rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>";
        byte[] packet = xml.getBytes(StandardCharsets.UTF_8);
        if (XMP.length + packet.length + 2 > 65535) throw new IOException("实况照片元数据过长");
        try (BufferedInputStream image = new BufferedInputStream(new FileInputStream(still));
             BufferedInputStream movie = new BufferedInputStream(new FileInputStream(video));
             DataOutputStream result = new DataOutputStream(new BufferedOutputStream(new FileOutputStream(output)))) {
            if (image.read() != 0xff || image.read() != 0xd8) throw new IOException("封面不是 JPEG");
            byte[] head = new byte[8];
            if (movie.read(head) != head.length || head[4] != 'f' || head[5] != 't' || head[6] != 'y' || head[7] != 'p') throw new IOException("视频不是 MP4");
            result.writeShort(0xffd8); result.writeShort(0xffe1); result.writeShort(XMP.length + packet.length + 2);
            result.write(XMP); result.write(packet);
            copy(image, result); result.write(head); copy(movie, result);
        } catch (IOException error) {
            if (output.exists() && !output.delete()) error.addSuppressed(new IOException("无法删除未完成的实况照片"));
            throw error;
        }
    }
    private static void copy(BufferedInputStream source, DataOutputStream destination) throws IOException {
        byte[] buffer = new byte[65536];
        int n;
        while ((n = source.read(buffer)) != -1) destination.write(buffer, 0, n);
    }
}
