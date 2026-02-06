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

    // Filter score levels based on region's labels (same logic as options)
    const scoreLevelList = region.object.scoreLevelList
      .filter((o: any) => {
        if (o.whenLabelValue) {
          const allowedLabels = o.whenLabelValue.split(',').map((l: string) => l.trim());
          return labelValues.some((lv: string) => allowedLabels.includes(lv));
        }
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

    const updateScoreAt = (index: number, newScores: string[]) => {
      runInAction(() => {
        const frame = sequence[index].frame;
        region.updateKeypointScore(frame, newScores);
      });
    };

    return (
      <div className={styles.container}>
        <SequenceFrames
          sequence={sequence}
          optionList={optionList}
          scoreLevelList={scoreLevelList}
          onUpdateFrame={updateFrameAt}
          onUpdateOptions={updateOptionsAt}
          onUpdateScore={updateScoreAt}
        />
      </div>
    );
  }
);



interface SeqProps {
  sequence: { frame: number; enabled?: boolean; options?: string[]; score?: string[] }[];
  optionList: { value: string; label: string }[];
  scoreLevelList: { value: string; label: string }[];
  onUpdateFrame: (index: number, newFrame: number) => void;
  onUpdateOptions: (index: number, newOptions: string[]) => void;
  onUpdateScore: (index: number, newScores: string[]) => void;
}

export const SequenceFrames: React.FC<SeqProps> = observer(
  ({ sequence, optionList, scoreLevelList, onUpdateOptions, onUpdateScore }) => {
    const [otherText, setOtherText] = useState<Record<number, string>>({});
    const [scoreOtherText, setScoreOtherText] = useState<Record<number, string>>({});

    const [needFocus, setNeedFocus] = useState<number | null>(null);
    const [scoreNeedFocus, setScoreNeedFocus] = useState<number | null>(null);
    const otherInputRef = useRef<HTMLInputElement>(null);
    const scoreOtherInputRef = useRef<HTMLInputElement>(null);


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

    const buildScoreOptions = (idx: number) => {
      const base = scoreLevelList.map((o) => (
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

    const handleScoreChange = (index: number, next: string[]) => {
      const old = sequence[index].score || [];
      const hadOther = old.includes('__other__');
      const hasOther = next.includes('__other__');

      if (hadOther && !hasOther) {
        setScoreOtherText((o) => {
          const clone = { ...o };
          delete clone[index];
          return clone;
        });
      }

      if (!hadOther && hasOther) {
        setScoreOtherText((o) => ({ ...o, [index]: '' }));
        setScoreNeedFocus(index);
      }

      onUpdateScore(index, next);
    };

    useEffect(() => {
      if (needFocus !== null) {
        otherInputRef.current?.focus();
        setNeedFocus(null);
      }
    }, [needFocus]);

    useEffect(() => {
      if (scoreNeedFocus !== null) {
        scoreOtherInputRef.current?.focus();
        setScoreNeedFocus(null);
      }
    }, [scoreNeedFocus]);

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

    const handleScoreOtherInputBlur = (index: number) => {
      const text = (scoreOtherText[index] || '').trim();
      if (!text) return;
      const oldScores = sequence[index].score || [];
      const newScores = oldScores.map((v) => (v === '__other__' ? text : v));
      onUpdateScore(index, newScores);
      setScoreOtherText((o) => {
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

          const showScoreOtherInput =
            (item.score || []).includes('__other__') &&
            scoreOtherText[idx] !== undefined;

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
                <Select
                  mode="multiple"
                  allowClear
                  className={styles.multiSelect}
                  placeholder="please select"
                  value={item.score || []}
                  onChange={(scores) => handleScoreChange(idx, scores)}
                  dropdownStyle={{ minWidth: 200 }}
                  style={{ width: '100%' }}
                >
                  {buildScoreOptions(idx)}
                </Select>
              </label>

              {showScoreOtherInput && (
                <div style={{ marginTop: 4 }}>
                  <Input
                    ref={scoreOtherInputRef}
                    size="small"
                    placeholder="Please enter custom score text"
                    value={scoreOtherText[idx]}
                    onChange={(e) =>
                      setScoreOtherText((o) => ({ ...o, [idx]: e.target.value }))
                    }
                    onBlur={() => handleScoreOtherInputBlur(idx)}
                    onPressEnter={() => handleScoreOtherInputBlur(idx)}
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