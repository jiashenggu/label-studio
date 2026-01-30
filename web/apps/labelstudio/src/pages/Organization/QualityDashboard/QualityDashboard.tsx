import { useEffect, useState } from "react";
import type { FC } from "react";
import { useAPI } from "../../../providers/ApiProvider";
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

interface ProjectMetrics {
  id: number;
  title: string;
  color?: string | null;
  metrics: QualityMetrics | null;
  error?: boolean;
}

interface AggregatedMetrics {
  totalProjects: number;
  totalAnnotations: number;
  totalTasks: number;
  totalCompletedAnnotations: number;
  totalSkippedAnnotations: number;
  totalGroundTruth: number;
  overallCompletionRate: number;
  totalAnnotators: number;
  avgLeadTime: number;
  projectsWithData: number;
}

const formatTime = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
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

export const QualityDashboard: QualityDashboardComponent = (() => {
  const api = useAPI();
  const [projectMetrics, setProjectMetrics] = useState<ProjectMetrics[]>([]);
  const [aggregatedMetrics, setAggregatedMetrics] = useState<AggregatedMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAllProjectsMetrics = async () => {
      console.log('=== Organization Quality Dashboard Fetch Start ===');
      
      try {
        setLoading(true);
        
        // Step 1: Fetch all projects
        console.log('Fetching all projects...');
        const projectsResponse = await api.callApi("projects", {
          params: {
            page_size: 1000, // Fetch a large number of projects
            include: "id,title,color",
          },
        });
        
        console.log('Projects fetched:', projectsResponse?.results?.length || 0);
        
        if (!projectsResponse?.results || projectsResponse.results.length === 0) {
          setError('No projects found in the organization');
          setLoading(false);
          return;
        }

        // Step 2: Fetch quality metrics for each project
        console.log('Fetching quality metrics for all projects...');
        const metricsPromises = projectsResponse.results.map(async (project: any) => {
          try {
            const metrics = await api.callApi("qualityMetrics", {
              params: {
                pk: project.id,
              },
            });
            return {
              id: project.id,
              title: project.title,
              color: project.color,
              metrics: metrics as QualityMetrics,
              error: false,
            };
          } catch (err) {
            console.warn(`Failed to fetch metrics for project ${project.id}:`, err);
            return {
              id: project.id,
              title: project.title,
              color: project.color,
              metrics: null,
              error: true,
            };
          }
        });

        const allMetrics = await Promise.all(metricsPromises);
        console.log('All metrics fetched:', allMetrics.length);
        
        setProjectMetrics(allMetrics);

        // Step 3: Aggregate metrics
        const aggregated = aggregateMetrics(allMetrics);
        setAggregatedMetrics(aggregated);
        
        setError(null);
        console.log('=== Organization Quality Dashboard Fetch Complete ===');
      } catch (err) {
        console.error('=== Error in fetchAllProjectsMetrics ===');
        console.error('Error:', err);
        setError('Failed to load organization quality metrics. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    fetchAllProjectsMetrics();
  }, [api]);

  const aggregateMetrics = (projects: ProjectMetrics[]): AggregatedMetrics => {
    let totalAnnotations = 0;
    let totalTasks = 0;
    let totalCompletedAnnotations = 0;
    let totalSkippedAnnotations = 0;
    let totalGroundTruth = 0;
    let totalLeadTime = 0;
    let projectsWithData = 0;
    const uniqueAnnotators = new Set<string>();

    projects.forEach(project => {
      if (project.metrics && !project.error) {
        projectsWithData++;
        totalAnnotations += project.metrics.total_annotations;
        totalTasks += project.metrics.total_tasks;
        totalCompletedAnnotations += project.metrics.completed_annotations;
        totalSkippedAnnotations += project.metrics.skipped_annotations;
        totalGroundTruth += project.metrics.ground_truth_annotations;
        totalLeadTime += project.metrics.avg_lead_time * project.metrics.total_annotations;
        
        // Collect unique annotators
        project.metrics.annotations_by_user.forEach(user => {
          uniqueAnnotators.add(user.name);
        });
      }
    });

    const overallCompletionRate = totalTasks > 0 
      ? (totalCompletedAnnotations / totalTasks) * 100 
      : 0;
    
    const avgLeadTime = totalAnnotations > 0 
      ? totalLeadTime / totalAnnotations 
      : 0;

    return {
      totalProjects: projects.length,
      totalAnnotations,
      totalTasks,
      totalCompletedAnnotations,
      totalSkippedAnnotations,
      totalGroundTruth,
      overallCompletionRate,
      totalAnnotators: uniqueAnnotators.size,
      avgLeadTime,
      projectsWithData,
    };
  };

  if (loading) {
    return (
      <Block name="quality-dashboard">
        <Elem name="loading">
          <Spinner size={48} />
          <p>Loading organization quality metrics...</p>
        </Elem>
      </Block>
    );
  }

  if (error || !aggregatedMetrics) {
    return (
      <Block name="quality-dashboard">
        <Elem name="error">
          <p>{error || 'No data available'}</p>
        </Elem>
      </Block>
    );
  }

  return (
    <Block name="quality-dashboard">
      <Elem name="header">
        <h1>Organization Quality Dashboard</h1>
        <p>Monitor annotation quality and track progress across all projects in your organization</p>
      </Elem>

      {/* Organization-wide Key Metrics */}
      <Elem name="section">
        <Elem name="section-title">Organization-Wide Metrics</Elem>
        <Elem name="metrics-grid">
          <MetricCard
            title="Total Projects"
            value={aggregatedMetrics.totalProjects}
            subtitle={`${aggregatedMetrics.projectsWithData} with annotation data`}
            color="blue"
          />
          <MetricCard
            title="Total Annotations"
            value={formatNumber(aggregatedMetrics.totalAnnotations)}
            subtitle={`${formatNumber(aggregatedMetrics.totalCompletedAnnotations)} completed, ${formatNumber(aggregatedMetrics.totalSkippedAnnotations)} skipped`}
            color="green"
          />
          <MetricCard
            title="Total Tasks"
            value={formatNumber(aggregatedMetrics.totalTasks)}
            subtitle={`${aggregatedMetrics.overallCompletionRate.toFixed(1)}% completion rate`}
            color="purple"
          />
          <MetricCard
            title="Total Annotators"
            value={aggregatedMetrics.totalAnnotators}
            subtitle={`Avg Lead Time: ${formatTime(aggregatedMetrics.avgLeadTime)}`}
            color="orange"
          />
        </Elem>
      </Elem>

      {/* Overall Completion Progress */}
      <Elem name="section">
        <Elem name="section-title">Overall Progress</Elem>
        <Elem name="completion-status">
          <ProgressBar
            percentage={aggregatedMetrics.overallCompletionRate}
            label={`Completed (${formatNumber(aggregatedMetrics.totalCompletedAnnotations)} / ${formatNumber(aggregatedMetrics.totalTasks)})`}
            color="green"
          />
        </Elem>
      </Elem>

      {/* Per-Project Metrics Table */}
      <Elem name="section">
        <Elem name="section-title">Project-Level Metrics</Elem>
        <Elem name="table-container">
          <table className="quality-dashboard__table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Total Annotations</th>
                <th>Total Tasks</th>
                <th>Completed</th>
                <th>Skipped</th>
                <th>Ground Truth</th>
                <th>Completion Rate</th>
                <th>Annotators</th>
                <th>Avg Lead Time</th>
              </tr>
            </thead>
            <tbody>
              {projectMetrics.map((project) => {
                if (project.error || !project.metrics) {
                  return (
                    <tr key={project.id}>
                      <td>
                        <Elem name="project-title">
                          {project.color && (
                            <Elem 
                              name="project-color" 
                              style={{ backgroundColor: project.color }}
                            />
                          )}
                          {project.title}
                        </Elem>
                      </td>
                      <td colSpan={8}>
                        <Elem name="error-message">No data available</Elem>
                      </td>
                    </tr>
                  );
                }

                const metrics = project.metrics;
                return (
                  <tr key={project.id}>
                    <td>
                      <Elem name="project-title">
                        {project.color && (
                          <Elem 
                            name="project-color" 
                            style={{ backgroundColor: project.color }}
                          />
                        )}
                        {project.title}
                      </Elem>
                    </td>
                    <td>{formatNumber(metrics.total_annotations)}</td>
                    <td>{formatNumber(metrics.total_tasks)}</td>
                    <td>{formatNumber(metrics.completed_annotations)}</td>
                    <td>{formatNumber(metrics.skipped_annotations)}</td>
                    <td>{formatNumber(metrics.ground_truth_annotations)}</td>
                    <td>
                      <Elem name="completion-badge" mod={{ 
                        high: metrics.completion_rate >= 75,
                        medium: metrics.completion_rate >= 25 && metrics.completion_rate < 75,
                        low: metrics.completion_rate < 25
                      }}>
                        {metrics.completion_rate.toFixed(1)}%
                      </Elem>
                    </td>
                    <td>{metrics.annotators_count}</td>
                    <td>{formatTime(metrics.avg_lead_time)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Elem>
      </Elem>

      {/* Top Annotators Across All Projects */}
      <Elem name="section">
        <Elem name="section-title">Top Annotators (Organization-Wide)</Elem>
        <Elem name="table-container">
          <table className="quality-dashboard__table">
            <thead>
              <tr>
                <th>Annotator</th>
                <th>Total Annotations</th>
                <th>Completed</th>
                <th>Skipped</th>
                <th>Avg Time</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Aggregate annotators across all projects
                const annotatorMap = new Map<string, {
                  count: number;
                  completed: number;
                  skipped: number;
                  totalTime: number;
                  annotationCount: number;
                }>();

                projectMetrics.forEach(project => {
                  if (project.metrics && !project.error) {
                    project.metrics.annotations_by_user.forEach(user => {
                      const existing = annotatorMap.get(user.name) || {
                        count: 0,
                        completed: 0,
                        skipped: 0,
                        totalTime: 0,
                        annotationCount: 0,
                      };
                      
                      annotatorMap.set(user.name, {
                        count: existing.count + user.count,
                        completed: existing.completed + user.completed,
                        skipped: existing.skipped + user.skipped,
                        totalTime: existing.totalTime + (user.avg_time * user.count),
                        annotationCount: existing.annotationCount + user.count,
                      });
                    });
                  }
                });

                // Convert to array and sort by count
                const topAnnotators = Array.from(annotatorMap.entries())
                  .map(([name, data]) => ({
                    name,
                    count: data.count,
                    completed: data.completed,
                    skipped: data.skipped,
                    avg_time: data.annotationCount > 0 ? data.totalTime / data.annotationCount : 0,
                  }))
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 10); // Top 10 annotators

                return topAnnotators.map((user, idx) => (
                  <tr key={idx}>
                    <td>{user.name}</td>
                    <td>{formatNumber(user.count)}</td>
                    <td>{formatNumber(user.completed)}</td>
                    <td>{formatNumber(user.skipped)}</td>
                    <td>{formatTime(user.avg_time)}</td>
                  </tr>
                ));
              })()}
            </tbody>
          </table>
        </Elem>
      </Elem>
    </Block>
  );
}) as QualityDashboardComponent;

// Required properties for Organization menu
QualityDashboard.title = "Quality Dashboard";
QualityDashboard.path = "/quality";
