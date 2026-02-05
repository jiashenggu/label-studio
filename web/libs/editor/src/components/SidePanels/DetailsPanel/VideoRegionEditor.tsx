import { Select, Input } from 'antd'; 
import { runInAction } from 'mobx';
import { observer } from 'mobx-react';
import type { Instance } from 'mobx-state-tree';
import type { VideoRegion } from '../../../regions/VideoRegion';
import styles from './TimelineRegionEditor.module.scss';
import { useState, useEffect, useRef, type FC } from 'react';

type VideoRegionModel = Instance<typeof VideoRegion>;
const { Option } = Select;

export const VideoRegionEditor = observer(
  ({ region }: { region: VideoRegionModel }) => {
    const { sequence } = region;
    
    // Get the labels assigned to this region
    const labelValues = region.labels || [];
    
    // Filter options based on region's labels
    const optionList = region.object.optionList
      .filter((o: any) => {
        // If option has whenLabelValue, only show if that label is selected
        if (o.whenLabelValue) {
          const allowedLabels = o.whenLabelValue.split(',').map((l: string) => l.trim());
          return labelValues.some((lv: string) => allowedLabels.includes(lv));
        }
        // If no whenLabelValue, always show the option
        return true;
      })
      .map((o: any) => ({
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

    const updateScoreAt = (index: number, newScore: number | undefined) => {
      runInAction(() => {
        const frame = sequence[index].frame;
        region.updateKeypointScore(frame, newScore);
      });
    };

    return (
      <div className={styles.container}>
        <SequenceFrames
          sequence={sequence}
          optionList={optionList}
          onUpdateFrame={updateFrameAt}
          onUpdateOptions={updateOptionsAt}
          onUpdateScore={updateScoreAt}
        />
      </div>
    );
  }
);



interface SeqProps {
  sequence: { frame: number; enabled?: boolean; options?: string[]; score?: number }[];
  optionList: { value: string; label: string }[];
  onUpdateFrame: (index: number, newFrame: number) => void;
  onUpdateOptions: (index: number, newOptions: string[]) => void;
  onUpdateScore: (index: number, newScore: number | undefined) => void;
}

export const SequenceFrames: React.FC<SeqProps> = observer(
  ({ sequence, optionList, onUpdateOptions, onUpdateScore }) => {
    const [otherText, setOtherText] = useState<Record<number, string>>({});

    const [needFocus, setNeedFocus] = useState<number | null>(null);
    const otherInputRef = useRef<HTMLInputElement>(null);


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


    const handleChange = (index: number, next: string[]) => {
      const old = sequence[index].options || [];
      const hadOther = old.includes('__other__');
      const hasOther = next.includes('__other__');

      if (hadOther && !hasOther) {
        setOtherText((o) => {
          const clone = { ...o };
          delete clone[index];
          return clone;
        });
        
      }

      if (!hadOther && hasOther) {
        setOtherText((o) => ({ ...o, [index]: '' }));
        setNeedFocus(index); 
      }

      onUpdateOptions(index, next);
    };

    useEffect(() => {
      if (needFocus !== null) {
        otherInputRef.current?.focus();
        setNeedFocus(null);
      }
    }, [needFocus]);

    const handleOtherInputBlur = (index: number) => {
      const text = (otherText[index] || '').trim();
      if (!text) return;
      const oldOpts = sequence[index].options || [];
      const newOpts = oldOpts.map((v) => (v === '__other__' ? text : v));
      onUpdateOptions(index, newOpts);
      setOtherText((o) => {
        const clone = { ...o };
        delete clone[index];
        return clone;
      });
    };

    const handleScoreChange = (index: number, value: string) => {
      const trimmed = value.trim();
      if (trimmed === '') {
        onUpdateScore(index, undefined);
      } else {
        const num = Number.parseFloat(trimmed);
        if (!Number.isNaN(num)) {
          onUpdateScore(index, num);
        }
      }
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

              <label className={styles.label}>
                <span className={styles.labelText}>score</span>
                <Input
                  type="number"
                  step="0.01"
                  className={styles.input}
                  placeholder="Enter score"
                  value={item.score ?? ''}
                  onChange={(e) => handleScoreChange(idx, e.target.value)}
                />
              </label>
            </div>
          );
        })}
      </>
    );
  }
);