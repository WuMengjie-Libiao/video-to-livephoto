import com.suikii.livephoto.MotionPhoto;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public class MotionPhotoCheck {
    public static void main(String[] args) throws Exception {
        if (args.length == 3) {
            MotionPhoto.write(Path.of(args[0]).toFile(),Path.of(args[1]).toFile(),Path.of(args[2]).toFile(),400000);
            return;
        }
        Path dir = Files.createTempDirectory("motion-photo-");
        try {
            byte[] jpeg = {(byte)0xff,(byte)0xd8,1,2,(byte)0xff,(byte)0xd9};
            byte[] mp4 = {0,0,0,12,'f','t','y','p',1,2,3,4};
            Path still=dir.resolve("a.jpg"), video=dir.resolve("v.mp4"), out=dir.resolve("a.MP.JPG");
            Files.write(still,jpeg); Files.write(video,mp4); MotionPhoto.write(still.toFile(),video.toFile(),out.toFile(),400000);
            byte[] data=Files.readAllBytes(out);
            if (!Arrays.equals(Arrays.copyOfRange(data,data.length-mp4.length,data.length),mp4)) throw new AssertionError("video bytes");
            String text=new String(data,StandardCharsets.ISO_8859_1);
            if (!text.contains("Item:Length=\"12\"") || !text.contains("Item:Length=\"0\"") || !text.contains("MotionPhotoPresentationTimestampUs=\"400000\"")) throw new AssertionError("XMP metadata");
            Files.write(still,new byte[] {0,1,2});
            try { MotionPhoto.write(still.toFile(),video.toFile(),out.toFile(),0); throw new AssertionError("bad JPEG accepted"); }
            catch (java.io.IOException expected) { if (Files.exists(out)) throw new AssertionError("partial file remains"); }
            System.out.println("ANDROID_CONTAINER_OK: metadata, original video bytes and failed output cleanup");
        } finally { try (var stream=Files.walk(dir)) { for (Path p : stream.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(p); } }
    }
}
