import { useEffect, useState } from "react";
import type { FC } from "react";
import { useAPI } from "../../../providers/ApiProvider";
import { useProject } from "../../../providers/ProjectProvider";
import { Block, Elem } from "../../../utils/bem";
import { Spinner } from "../../../components/Spinner/Spinner";
import "./quality-dashboard.scss";

// Define component type with static properties
interface QualityDashboardComponent extends FC {
  title: string;
  path: string;
}

interface QualityMetrics {
  total_annotations: number;
  total_tasks: number;
  completed_annotations: number;
  skipped_annotations: number;
  ground_truth_annotations: number;
  avg_lead_time: number;
  median_lead_time: number;
  annotations_per_task: number;
  completion_rate: number;
  annotators_count: number;
  annotations_by_user: Array<{
    name: string;
    count: number;
    avg_time: number;
    skipped: number;
    completed: number;
  }>;
  annotations_over_time: Array<{
    date: string;
    count: number;
    completed: number;
    skipped: number;
  }>;
  lead_time_distribution: Array<{
    range: string;
    count: number;
  }>;
  recent_annotations: Array<{
    id: number;
    created_at: string;
    lead_time: number;
    was_cancelled: boolean;
    ground_truth: boolean;
    annotator: string;
    task_id: number;
    result_count: number;
  }>;
  task_completion_status: {
    total: number;
    completed: number;
    in_progress: number;
    not_started: number;
  };
}

const formatTime = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const MetricCard: FC<{ title: string; value: string | number; subtitle?: string; color?: string }> = ({ 
  title, 
  value, 
  subtitle,
  color = "blue"
}) => (
  <Block name="metric-card" mod={{ [color]: true }}>
    <Elem name="title">{title}</Elem>
    <Elem name="value">{value}</Elem>
    {subtitle && <Elem name="subtitle">{subtitle}</Elem>}
  </Block>
);

const ProgressBar: FC<{ percentage: number; label: string; color?: string }> = ({ 
  percentage, 
  label,
  color = "blue"
}) => {
  const hasProgress = percentage > 0;
  
  return (
    <Block name="progress-bar">
      <Elem name="label">
        <span>{label}</span>
        <span>{percentage.toFixed(1)}%</span>
      </Elem>
      <Elem name="track">
        {hasProgress && (
          <Elem name="fill" mod={{ [color]: true }} style={{ width: `${percentage}%` }} />
        )}
      </Elem>
    </Block>
  );
};

export const QualityDashboard = (() => {
  const api = useAPI();
  const { project } = useProject();
  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      console.log('=== Quality Dashboard Fetch Start ===');
      console.log('Project ID:', project?.id);
      
      try {
        setLoading(true);
        
        // Use the API instance to make the call with proper authentication
        console.log('Calling API...');
        const metricsResponse = await api.callApi("qualityMetrics", {
          params: {
            pk: project.id,
          },
        });
        
        console.log('API Response:', metricsResponse);
        console.log('Response type:', typeof metricsResponse);
        console.log('Response keys:', metricsResponse ? Object.keys(metricsResponse) : 'null');
        
        // Check if response has data
        if (metricsResponse && typeof metricsResponse === 'object') {
          console.log('Setting metrics...');
          setMetrics(metricsResponse);
          setError(null);
          console.log('Metrics set successfully!');
        } else {
          console.error('Invalid response format:', metricsResponse);
          throw new Error('Invalid response format');
        }
      } catch (err) {
        console.error('=== Error in fetchMetrics ===');
        console.error('Error:', err);
        console.error('Error message:', err.message);
        console.error('Error stack:', err.stack);
        setError('Failed to load quality metrics. Please check your project has annotations.');
      } finally {
        setLoading(false);
        console.log('=== Quality Dashboard Fetch End ===');
      }
    };

    if (project?.id) {
      console.log('Project ID found, starting fetch:', project.id);
      fetchMetrics();
    } else {
      console.log('No project ID, skipping fetch');
    }
  }, [project?.id, api]);

  if (loading) {
    return (
      <Block name="quality-dashboard">
        <Elem name="loading">
          <Spinner size={48} />
          <p>Loading quality metrics...</p>
        </Elem>
      </Block>
    );
  }

  if (error || !metrics) {
    return (
      <Block name="quality-dashboard">
        <Elem name="error">
          <p>{error || 'No data available'}</p>
        </Elem>
      </Block>
    );
  }

  // Calculate percentages for task completion (only Completed and Not Started)
  const completionPercentage = (metrics.task_completion_status.completed / metrics.task_completion_status.total) * 100 || 0;
  const notStartedPercentage = (metrics.task_completion_status.not_started / metrics.task_completion_status.total) * 100 || 0;

  return (
    <Block name="quality-dashboard">
      <Elem name="header">
        <h1>Annotation Quality Dashboard</h1>
        <p>Monitor annotation quality and track progress across your project</p>
      </Elem>

      {/* Key Metrics */}
      <Elem name="section">
        <Elem name="section-title">Key Metrics</Elem>
        <Elem name="metrics-grid">
          <MetricCard
            title="Total Annotations"
            value={metrics.total_annotations}
            subtitle={`${metrics.completed_annotations} completed, ${metrics.skipped_annotations} skipped`}
            color="blue"
          />
          <MetricCard
            title="Total Tasks"
            value={metrics.total_tasks}
            subtitle={`${metrics.completion_rate.toFixed(1)}% completion rate`}
            color="green"
          />
          <MetricCard
            title="Avg Lead Time"
            value={formatTime(metrics.avg_lead_time)}
            subtitle={`Median: ${formatTime(metrics.median_lead_time)}`}
            color="purple"
          />
          <MetricCard
            title="Annotators"
            value={metrics.annotators_count}
            subtitle={`${metrics.annotations_per_task.toFixed(1)} annotations per task`}
            color="orange"
          />
        </Elem>
      </Elem>

      {/* Task Completion Status */}
      <Elem name="section">
        <Elem name="section-title">Task Completion Status</Elem>
        <Elem name="completion-status">
          <ProgressBar
            percentage={completionPercentage}
            label={`Completed (${metrics.task_completion_status.completed})`}
            color="green"
          />
          <ProgressBar
            percentage={notStartedPercentage}
            label={`Not Started (${metrics.task_completion_status.not_started})`}
            color="gray"
          />
        </Elem>
      </Elem>

      {/* Annotations by User */}
      <Elem name="section">
        <Elem name="section-title">Top Annotators</Elem>
        <Elem name="table-container">
          <table className="quality-dashboard__table">
            <thead>
              <tr>
                <th>Annotator</th>
                <th>Total</th>
                <th>Completed</th>
                <th>Skipped</th>
                <th>Avg Time</th>
              </tr>
            </thead>
            <tbody>
              {metrics.annotations_by_user.map((user, idx) => (
                <tr key={idx}>
                  <td>{user.name}</td>
                  <td>{user.count}</td>
                  <td>{user.completed}</td>
                  <td>{user.skipped}</td>
                  <td>{formatTime(user.avg_time || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Elem>
      </Elem>

      {/* Annotations Over Time */}
      <Elem name="section">
        <Elem name="section-title">Annotations Over Time (Last 30 Days)</Elem>
        <Elem name="chart-container">
          <Elem name="timeline-chart">
            {metrics.annotations_over_time.map((item, idx) => {
              const maxCount = Math.max(...metrics.annotations_over_time.map(i => i.count));
              const height = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
              
              return (
                <Elem name="timeline-bar" key={idx}>
                  <Elem name="bar-container">
                    <Elem 
                      name="bar" 
                      mod={{ completed: true }}
                      style={{ height: `${height}%` }}
                      title={`${item.completed} completed`}
                    />
                  </Elem>
                  <Elem name="bar-label">{formatDate(item.date)}</Elem>
                  <Elem name="bar-value">{item.count}</Elem>
                </Elem>
              );
            })}
          </Elem>
        </Elem>
      </Elem>

      {/* Lead Time Distribution */}
      <Elem name="section">
        <Elem name="section-title">Lead Time Distribution</Elem>
        <Elem name="distribution">
          {metrics.lead_time_distribution.map((bucket, idx) => {
            const maxCount = Math.max(...metrics.lead_time_distribution.map(b => b.count));
            const width = maxCount > 0 ? (bucket.count / maxCount) * 100 : 0;
            
            return (
              <Elem name="distribution-item" key={idx}>
                <Elem name="distribution-label">{bucket.range}</Elem>
                <Elem name="distribution-bar-container">
                  <Elem 
                    name="distribution-bar" 
                    style={{ width: `${width}%` }}
                  />
                </Elem>
                <Elem name="distribution-count">{bucket.count}</Elem>
              </Elem>
            );
          })}
        </Elem>
      </Elem>

      {/* Recent Annotations */}
      <Elem name="section">
        <Elem name="section-title">Recent Annotations</Elem>
        <Elem name="table-container">
          <table className="quality-dashboard__table">
            <thead>
              <tr>
                <th>Task ID</th>
                <th>Annotator</th>
                <th>Time</th>
                <th>Lead Time</th>
                <th>Regions</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {metrics.recent_annotations.map((ann) => (
                <tr key={ann.id}>
                  <td>#{ann.task_id}</td>
                  <td>{ann.annotator}</td>
                  <td>{new Date(ann.created_at).toLocaleString()}</td>
                  <td>{formatTime(ann.lead_time || 0)}</td>
                  <td>{ann.result_count}</td>
                  <td>
                    <Elem 
                      name="status-badge" 
                      mod={{ 
                        skipped: ann.was_cancelled,
                        completed: !ann.was_cancelled,
                        groundTruth: ann.ground_truth
                      }}
                    >
                      {ann.ground_truth ? 'Ground Truth' : ann.was_cancelled ? 'Skipped' : 'Completed'}
                    </Elem>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Elem>
      </Elem>
    </Block>
  );
});

// Required properties for Settings menu
QualityDashboard.title = "Quality Dashboard";
QualityDashboard.path = "/quality";

