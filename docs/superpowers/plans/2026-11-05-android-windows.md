# Android 与 Windows 交付计划

目标：Android 和 Windows 完成导入视频、截取、封面、比例、实况预览和确认保存；原比例为默认。保留现有 iPhone 更改。

起始事实：Electron 已提供 Windows UI、后台编码和 Motion Photo 交付，但缺少手机端已有的比例功能；Windows 真机与安装包尚未验证。Android 原生工程不存在。

实现：
- Windows 与现有 Mac Electron 共享媒体契约：素材各自持有比例，按实际方向居中裁切，成片封面、动态视频及预览一致；输出单文件 Motion Photo。维护重名保护与确认保存语义。Windows 平台测试使用 Windows CI，不能将 Mac 结果当作 Windows 真机验证。
- Android 使用系统选片、Media3 Transformer 离线裁剪/编码与比例处理、JPEG + MP4 拼接 Motion Photo；封面从编码片段抽取，预览私有文件，确认后用 MediaStore 写入图片图库。权限、异常和临时文件生命周期由安卓端负责；不声称所有厂商图库或微信识别。
- 测试：桌面合成视频检验方向/比例、视频和封面尺寸、源文件及最终字节；Android 测容器元数据和模拟器导入、预览、保存、比例。SDK 条款由用户决定；若环境不可用，记录未完成部分。

## 本轮进度

- Electron 支持每个视频独立选择比例，默认原比例；预览按选中比例居中裁切，后台使用相同裁切并从实际视频提取封面。Node 核心测试覆盖正常横屏、旋转视频、四种比例、无效输入及封面/视频尺寸；Electron 实际界面测试覆盖选比例、成片预览与输出一致。Mac 运行通过，尚未在 Windows 系统运行。新增 Windows Actions 工作流，未推送也未运行。
- 新增 Android 工程，使用用户同意安装的 SDK 构建调试 APK，并在 Android 15 模拟器验证导入、拖动选段、封面选择、1:1 与原比例、静音与有声、预览返回和确认保存。提取保存的 Motion Photo 验证视频比例、音轨与文件结构；取消预览未写入相册。厂商图库和分享识别尚需真机测试。
- Windows 需要在 Windows 机器或新增的 Windows Actions 工作流验证打包、路径和 FFmpeg，再提供经过验证的 Windows 安装包。
