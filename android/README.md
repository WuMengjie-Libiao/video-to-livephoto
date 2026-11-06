# Android 版

目标是从手机选视频，截取片段、选择封面与比例、预览后保存单文件 Motion Photo 到系统相册。本地使用 Media3 处理视频，并通过 MediaStore 保存；不需要把素材上传到服务器。

已在 Android 15 模拟器构建并验证选片、截取、比例、预览和保存，以及有声、静音导出的文件结构。另在带 Google Play 的 Android 15 模拟器中，用 Google 相册 6.84 打开生成的有声样本，确认其识别动态照片并播放画面；该模拟器未验证声音播放。调试版 APK 可用于安装测试；尚未在真实手机上验证，不同品牌相册和微信、抖音对动态照片的识别需要分别实测。

项目最低支持 Android 10（API 29）；构建需要 JDK 17 或更高版本、Android SDK Platform 35 和对应的 Build Tools。安装 Android SDK 前需要阅读并接受 [Android SDK 许可](https://developer.android.com/studio/terms)。

安装并配置好 SDK 后，可以从本目录执行：

```bash
./gradlew assembleDebug
```

成功时的调试安装包为 `app/build/outputs/apk/debug/app-debug.apk`。调试签名由 Android 构建工具生成；正式发布应另行管理签名。

纯 Java 的文件格式检查不需要 SDK：

```bash
mkdir -p /tmp/photolive-android-check
javac -d /tmp/photolive-android-check app/src/main/java/com/suikii/livephoto/MotionPhoto.java tests/MotionPhotoCheck.java
java -cp /tmp/photolive-android-check MotionPhotoCheck
```

Motion Photo 格式参考 [Android 官方格式说明](https://developer.android.com/media/platform/motion-photo-format)。
