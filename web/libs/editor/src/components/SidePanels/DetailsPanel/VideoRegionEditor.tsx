import { Select, Input } from 'antd'; 
import { runInAction } from 'mobx';
import { observer } from 'mobx-react';
import type { Instance } from 'mobx-state-tree';
import { VideoRegion } from '../../../regions/VideoRegion';
import styles from './TimelineRegionEditor.module.scss';
import { useState, useEffect, useRef } from 'react';

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

        /* 记录哪一行需要自动聚焦 */
    const [needFocus, setNeedFocus] = useState<number | null>(null);
    const otherInputRef = useRef<HTMLInputElement>(null);

    /* 当选到 __other__ 时，标记需要聚焦 */

    /* 统一构造“下拉框选项”：正常选项 + 一个 other */
    const buildOptions = (idx: number) => {
      const base = optionList.map((o) => (
        <Option key={o.value} value={o.value}>
          {o.label}
        </Option>
      ));
      base.push(
        <Option key="__other__" value="__other__">
          Customize
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
        setNeedFocus(index); 
      }

      onUpdateOptions(index, next);
    };

        /* 渲染完成后聚焦，然后立即把标记清掉 */
    useEffect(() => {
      if (needFocus !== null) {
        otherInputRef.current?.focus();   // ← 直接聚焦原生元素
        setNeedFocus(null);
      }
    }, [needFocus]);

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
                <span className={styles.labelText}>options</span>
                <Select
                  mode="multiple"
                  allowClear
                  className={styles.multiSelect}
                  placeholder="please select"
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
                    ref={otherInputRef} 
                    size="small"
                    placeholder="Please enter custom text"
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