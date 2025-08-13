
from insightface.app import FaceAnalysis
import cv2
import os
import json

def extract_face_features(image_path):
    app = FaceAnalysis(name="buffalo_s")
    app.prepare(ctx_id=-1)

    if not os.path.exists(image_path):
        print(f"图片路径不存在：{image_path}")
        return None

    img = cv2.imread(image_path)
    if img is None:
        print(f"图片读取失败：{image_path}")
        return None

    h, w = img.shape[:2]
    faces = app.get(img)

    result = {
        "imagePath": image_path,
        "imageSize": [w, h],
        "faceCount": len(faces),
        "isSinglePerson": len(faces) == 1,
        "isTwoPeople": len(faces) == 2,
        "isGroupPhoto": len(faces) >= 3,
        "faces": []
    }

    # 计算所有 bbox 的 IoU 判断是否重叠
    def compute_iou(box1, box2):
        x1 = max(box1[0], box2[0])
        y1 = max(box1[1], box2[1])
        x2 = min(box1[2], box2[2])
        y2 = min(box1[3], box2[3])
        inter_area = max(0, x2 - x1) * max(0, y2 - y1)
        area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
        area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
        union_area = area1 + area2 - inter_area
        return inter_area / union_area if union_area > 0 else 0

    bboxes = []
    area_ratios = []

    for i, face in enumerate(faces):
        bbox = face.bbox.astype(int).tolist()
        x1, y1, x2, y2 = bbox
        cx = int((x1 + x2) / 2)
        cy = int((y1 + y2) / 2)
        area = (x2 - x1) * (y2 - y1)
        area_ratio = round(area / (w * h), 4)
        area_ratios.append(area_ratio)

        # 判断位置（粗分区）
        horizontal = "left" if cx < w/3 else "center" if cx < w*2/3 else "right"
        vertical = "top" if cy < h/3 else "middle" if cy < h*2/3 else "bottom"

        face_info = {
            "gender": "male" if face.gender == 1 else "female",
            "age": int(face.age),
            "bbox": bbox,
            "centerPoint": [cx, cy],
            "areaRatio": area_ratio,
            "position": {
                "horizontal": horizontal,
                "vertical": vertical
            },
            "landmarks": face.landmark.astype(int).tolist(),
            "embedding": face.embedding.tolist()
        }

        bboxes.append(bbox)
        result["faces"].append(face_info)

    # 判断人脸是否重叠
    is_overlapping = False
    for i in range(len(bboxes)):
        for j in range(i + 1, len(bboxes)):
            if compute_iou(bboxes[i], bboxes[j]) > 0.05:
                is_overlapping = True
                break

    result["hasFaceOverlap"] = is_overlapping

    # ✅ 新增逻辑
    result["isSelfie"] = (len(faces) == 1 and area_ratios[0] > 0.15)
    result["isGroupPhotoByRule"] = len(faces) >= 3

    return result

# 示例调用
if __name__ == "__main__":
    test_path = "testImg.jpg"
    info = extract_face_features(test_path)
    if info:
        print(json.dumps(info, indent=2, ensure_ascii=False))
