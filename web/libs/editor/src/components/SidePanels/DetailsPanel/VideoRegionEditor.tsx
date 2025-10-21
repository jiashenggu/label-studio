import { Select, Input } from 'antd'; 
import { runInAction } from 'mobx';
import { observer } from 'mobx-react';
import type { Instance } from 'mobx-state-tree';
import { VideoRegion } from '../../../regions/VideoRegion';
import styles from './TimelineRegionEditor.module.scss';
import { useState } from 'react';

type VideoRegionModel = Instance<typeof VideoRegion>;
const { Option } = Select;

export const VideoRegionEditor = observer(
  ({ region }: { region: VideoRegionModel }) => {
    const { sequence } = region;
    const optionList = region.object.optionList.map((o) => ({
      value: o.value,
      label: o.label,
    }));

    const updateFrameAt = (index: number, newFrame: number) => {
      runInAction(() => {
        region.sequence = sequence.map((item, idx) =>
          idx === index ? { ...item, frame: newFrame } : item
        );
      });
    };

    const updateOptionsAt = (index: number, newOptions: string[]) => {
      runInAction(() => {
        const frame = sequence[index].frame;
        region.updateKeypointOptions(frame, newOptions);
      });
    };

    return (
      <div className={styles.container}>
        <SequenceFrames
          sequence={sequence}
          optionList={optionList}
          onUpdateFrame={updateFrameAt}
          onUpdateOptions={updateOptionsAt}
        />
      </div>
    );
  }
);

/* ---------------- 子组件 ---------------- */


interface SeqProps {
  sequence: { frame: number; enabled?: boolean; options?: string[] }[];
  optionList: { value: string; label: string }[];
  onUpdateFrame: (index: number, newFrame: number) => void;
  onUpdateOptions: (index: number, newOptions: string[]) => void;
}

export const SequenceFrames: React.FC<SeqProps> = observer(
  ({ sequence, optionList, onUpdateOptions }) => {
    /* 存每一行自定义文本：{ [index]: string } */
    const [otherText, setOtherText] = useState<Record<number, string>>({});

    /* 统一构造“下拉框选项”：正常选项 + 一个 other */
    const buildOptions = (idx: number) => {
      const base = optionList.map((o) => (
        <Option key={o.value} value={o.value}>
          {o.label}
        </Option>
      ));
      base.push(
        <Option key="__other__" value="__other__">
          其他（自定义）
        </Option>
      );
      return base;
    };

    /* 处理 Select 变化 */
    const handleChange = (index: number, next: string[]) => {
      const old = sequence[index].options || [];
      const hadOther = old.includes('__other__');
      const hasOther = next.includes('__other__');

      /* 如果取消了 other，把对应的自定义文本也清掉 */
      if (hadOther && !hasOther) {
        setOtherText((o) => {
          const clone = { ...o };
          delete clone[index];
          return clone;
        });
      }

      /* 如果新选了 other，先塞一个空字符串占位，方便下面输入框受控 */
      if (!hadOther && hasOther) {
        setOtherText((o) => ({ ...o, [index]: '' }));
      }

      onUpdateOptions(index, next);
    };

    /* 自定义文本输入完，把 __other__ 替换成真实文本 */
    const handleOtherInputBlur = (index: number) => {
      const text = (otherText[index] || '').trim();
      if (!text) return; // 空文本不替换
      const oldOpts = sequence[index].options || [];
      const newOpts = oldOpts.map((v) => (v === '__other__' ? text : v));
      onUpdateOptions(index, newOpts);
      /* 同时把 otherText 清掉，避免下次再看到输入框 */
      setOtherText((o) => {
        const clone = { ...o };
        delete clone[index];
        return clone;
      });
    };

    return (
      <>
        {sequence.map((item, idx) => {
          const showOtherInput =
            (item.options || []).includes('__other__') &&
            otherText[idx] !== undefined;

          return (
            <div key={idx} className={styles.row}>
              <label className={styles.label}>
                <span className={styles.labelText}>Frame {idx}</span>
                <input
                  className={styles.input}
                  type="text"
                  value={item.frame}
                  readOnly
                />
              </label>

              <label className={styles.label}>
                <span className={styles.labelText}>选项</span>
                <Select
                  mode="multiple"
                  allowClear
                  className={styles.multiSelect}
                  placeholder="请选择"
                  value={item.options || []}
                  onChange={(opts) => handleChange(idx, opts)}
                  dropdownStyle={{ minWidth: 200 }}
                  style={{ width: '100%' }}
                >
                  {buildOptions(idx)}
                </Select>
              </label>

              {/* 其他输入框 */}
              {showOtherInput && (
                <div style={{ marginTop: 4 }}>
                  <Input
                    size="small"
                    placeholder="请输入自定义内容"
                    value={otherText[idx]}
                    onChange={(e) =>
                      setOtherText((o) => ({ ...o, [idx]: e.target.value }))
                    }
                    onBlur={() => handleOtherInputBlur(idx)}
                    onPressEnter={() => handleOtherInputBlur(idx)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  }
);