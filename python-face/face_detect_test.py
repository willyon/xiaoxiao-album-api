'''
Author: zhangshouchang
Date: 2025-08-05 08:56:14
LastEditors: zhangshouchang
LastEditTime: 2025-08-05 09:15:53
Description: File description
'''
from insightface.app import FaceAnalysis
import matplotlib.pyplot as plt
import cv2


# 初始化模型(只有 buffalo_s 和 buffalo_l 才内置了性别/年龄估计功能。)
app = FaceAnalysis(name="buffalo_s")
# 使用cpu ctx_id=-1 表示使用 CPU 第一次运行 prepare() 时会自动下载模型到 ~/.insightface/models
app.prepare(ctx_id=-1)

# 加载一张人脸图片（你需要换成自己的图片路径）
img = cv2.imread("testImg.jpg")
faces = app.get(img)

print(f"检测到 {len(faces)} 张人脸")
for i, face in enumerate(faces):
    print(f"第 {i+1} 张人脸，性别：{'男' if face.gender == 1 else '女'}，年龄：{face.age}")

# 复制一份图像用于画框
img_draw = img.copy()

for i, face in enumerate(faces):
    # 获取人脸框坐标（整数化）
    bbox = face.bbox.astype(int)  # [x1, y1, x2, y2]

    # 绘制人脸框
    cv2.rectangle(img_draw, (bbox[0], bbox[1]), (bbox[2], bbox[3]), color=(0, 255, 0), thickness=2)

    # 准备文字内容（性别 + 年龄）
    gender_text = "man" if face.gender == 1 else "female"
    age_text = f"age:{int(face.age)}"
    label = f"{gender_text}, {age_text}"

    # 写在框的上方
    cv2.putText(
        img_draw,
        label,
        (bbox[0], max(bbox[1] - 10, 0)),
        fontFace=cv2.FONT_HERSHEY_SIMPLEX,
        fontScale=0.6,
        color=(255, 0, 0),
        thickness=2
    )

# OpenCV 是 BGR，需要转为 RGB
img_rgb = cv2.cvtColor(img_draw, cv2.COLOR_BGR2RGB)

# 使用 matplotlib 显示
plt.figure(figsize=(10, 8))
plt.imshow(img_rgb)
plt.title("Detected Faces with Age & Gender")
plt.axis("off")
plt.show()