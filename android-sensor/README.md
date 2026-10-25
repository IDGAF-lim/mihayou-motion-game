# 指定 MihaSensor 的增强重构版

原文件：用户提供的 `MihaSensor-debug.apk.1`，`com.mihayou.sensor` v0.4.9 / 16。

原件 SHA256：`ED3CB68E13550206D6EE666E02B337116B87304FE96C6012A9A164164718F659`。

没有原 Android 工程。本目录基于该 APK 的静态恢复结果重建界面结构、姿态补偿 `PoseFrame` 和重力滤波管线，保留原先局域网 WebSocket 发送方式，补充同步测量与动作生命周期控制。不是原项目源码的无损还原，也没有声称使用原签名。

## 安装

安装 `apps/MihaSensor-integrated.apk`，桌面名称“咪哈友·原版增强”，包名 `com.mihayou.sensor.integrated`，版本 `0.5.0-integration`。独立开发签名，和原版并存，不必卸载原 App；同时只启动一个控制器发送动作。

1. 地址填 `ws://电脑IP:端口/sensor`，点“连接并测量”，等 RTT 有数值。
2. 点“开始检测并示教”，静止约 1 秒完成握姿参考校准。
3. 沿你想定义为“上挥”的方向明显挥一次，末端停稳、缓慢回位并停稳，完成示教。示教不发游戏动作。
4. 同方向正式挥动为上挥；完全相反方向为下挥。原姿态补偿将运动换算到初始握姿参考系，再沿示教轴判定，不强制手机顶部/底部。
5. 挥动识别后锁定；末端停稳、反向回位、再次停稳后才解锁。回位不发动作。卡住且已经实际回到原位时点“已回位，重新就绪”，仍需静止 350ms。
6. 阈值可调，示教会自动估计；改变握姿、换人或重新开始检测后重新示教。
7. 电脑游戏页可试听实时调偏移或八拍自动校准。采样波动、手感和零误触仍需真机测试。

共享识别核心来自 `../android/src/com/mihayou/linktest/SwingDetector.java`，同一份代码通过构建参数引入，避免两份算法不一致。测试覆盖方向示教、反方向、末端刹车、完整复位、单点噪声、采样间断和阈值。

## 通信

原 APK 的原始 WebSocket 动作通道保持兼容。增强版同一 App 额外每秒执行 HTTP 四时间戳同步，动作携带 `clientId/sessionId/runId/sequence/sensorTimeMs`。`SensorEvent.timestamp` 与同步都使用手机单调时钟；电脑提供 RTT 中位数、P95 与条件性估算上行时间。

单次动作发送不重试，队列最多 2 个等待项；超过 400ms、换连接或换测试局的旧动作丢弃。HTTP 探测失败后自动重连，退后台停止识别与连接，回前台手动连接。Socket 仍只发送，连接健康主要依赖同步探测与发送错误，手机显示“已发出”不是服务器动作确认；真实送达看电脑记录。

## 构建与检查

使用 JDK 17、Android 35 平台及 Build Tools，运行 `build.ps1`，可显式传 `-JavaHome -BuildTools -AndroidJar -SigningKey -OutputApk`。原模块 `../android/build.ps1` 负责通用构建流程。开发签名密钥不分发、不入 Git。需要做后续覆盖更新时保留自己的同一签名密钥。

APK 已用 Java 8 目标编译，完成 APK v2/v3 签名校验；未在真实 Android 手机或模拟器上安装验收。

`npm run test:sensor` 在 JVM 上执行实际的 `SensorLink`、`SimpleWebSocket` 和共享识别代码，与真实 Node 服务交互。需要设置 `JAVA_HOME` 及 `JSON_JAR`（测试时使用 `org.json:json:20250517`；手机运行使用 Android 自带 JSONObject，无外部依赖）。

测试验证握姿坐标换算、四时间戳、真实协议传输、过期/断线不补发和 23 条识别断言。JVM 测试不是 Android 安装测试，也不是传感器准确率实验。
