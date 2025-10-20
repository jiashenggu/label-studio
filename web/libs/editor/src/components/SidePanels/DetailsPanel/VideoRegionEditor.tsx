import { runInAction } from 'mobx';
import { observer } from 'mobx-react';
import type { Instance } from 'mobx-state-tree';
import { VideoRegion } from '../../../regions/VideoRegion';
import styles from './TimelineRegionEditor.module.scss';

// 假设你的 MST model 叫 VideoRegionModel
type VideoRegionModel = Instance<typeof VideoRegion>;

export const VideoRegionEditor = observer(
  ({ region }: { region: VideoRegionModel }) => {
    const { sequence } = region;

    /* 修改某一帧的 frame 值 */
    const updateFrameAt = (index: number, newFrame: number) => {
      runInAction(() => {
        region.sequence = sequence.map((item, idx) =>
          idx === index ? { ...item, frame: newFrame } : item
        );
      });
    };

    return (
      <div className={styles.container}>
        <SequenceFrames sequence={sequence} onUpdate={updateFrameAt} />
      </div>
    );
  }
);


interface SeqProps {
  sequence: { frame: number; enabled?: boolean }[];
  onUpdate: (index: number, newFrame: number) => void;
}

const SequenceFrames: React.FC<SeqProps> = observer(({ sequence }) => (
  <>
    {sequence.map((item, idx) => (
      <label key={idx} className={styles.label}>
        <span className={styles.labelText}>Frame {idx}</span>
        <input
          className={styles.input}
          type="text"
          value={item.frame}
          readOnly
        />
      </label>
    ))}
  </>
));