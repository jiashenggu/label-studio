from typing import List, Dict, Tuple
import json

def get_ranges(sequence: List[dict], framesCount: int) -> List[Tuple[int, int]]:
    """
    把 sequence 转成左闭右开的区间列表
    例如 sequence=[{frame:1,enabled:T}, {frame:19,enabled:T}]
    -> [(1,19)]
    """
    ranges = []
    if not sequence:
        return ranges

    # 按 frame 升序
    seq = sorted(sequence, key=lambda d: d['frame'])
    start = None

    for item in seq:
        frame = item['frame']
        enabled = item['enabled']
        if enabled and start is None:
            start = frame
        elif enabled and start is not None:
            ranges.append((start, frame-1))
            start = frame
        elif not enabled and start is not None:
            ranges.append((start, frame-1))
            start = None
    # 如果结尾仍是 enabled==True，就收到最后一帧+1
    if start is not None:
        last_frame = seq[-1]['frame']
        ranges.append((start, framesCount))
    return ranges


def extract_label_ranges(annotation_list: List[dict]) -> Dict[str, List[Tuple[int, int]]]:
    """
    把每个标签的区间全部算出来
    返回: {'Subgoal':[(...),...], 'Success':[(...),...], ...}
    """
    label2ranges = {}
    for ann in annotation_list:
        value = ann['value']
        label = value['labels'][0]          # 每个 result 只有一个 label
        seq   = value['sequence']
        framesCount = value['framesCount']
        label2ranges[label] = get_ranges(seq, framesCount)
    print(label2ranges)
    return label2ranges


def report_subgoal_intersect(label2ranges: Dict[str, List[Tuple[int, int]]]):
    """
    在 Success/Failure/Suboptimal 的每一段里，只要包含任意 Subgoal 的 keyframe，
    就输出该区间的范围和对应标签
    """
    subgoal_ranges = label2ranges.get('Subgoal', [])
    # 需要扫描的三种标签
    for target_label in ('Success', 'Failure', 'Suboptimal'):
        for s, e in label2ranges.get(target_label, []):
            # 看是否和任意 subgoal 区间有交集
            if any(s < sg_s < e for sg_s, sg_e in subgoal_ranges):
                print(f'区间 [{s}, {e}) 包含 Subgoal，对应标签：{target_label}')


# ----------------- 测试 -----------------
if __name__ == '__main__':
    # 直接把题目给的 JSON 中 result 部分粘过来
    with open("/home/gear/Downloads/project-2-at-2025-10-15-08-42-5df5517e.json") as f:
        results = json.load(f)
    
    for result in results:
        for annotation in result['annotations']:
            label2ranges = extract_label_ranges(annotation['result'])
            report_subgoal_intersect(label2ranges)