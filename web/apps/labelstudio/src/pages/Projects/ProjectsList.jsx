import chr from "chroma-js";
import { format } from "date-fns";
import { useCallback, useContext, useMemo } from "react";
import { NavLink } from "react-router-dom";
import { IconCheck, IconEllipsis, IconMinus, IconSparks } from "@humansignal/icons";
import { Userpic, Button, useToast } from "@humansignal/ui";
import { Dropdown, Menu, Pagination } from "../../components";
import { modal } from "../../components/Modal/Modal";
import { useModalControls } from "../../components/Modal/ModalPopup";
import Input from "../../components/Form/Elements/Input/Input";
import { Space } from "../../components/Space/Space";
import { ApiContext } from "../../providers/ApiProvider";
import { Block, Elem } from "../../utils/bem";
import { absoluteURL } from "../../utils/helpers";

const DEFAULT_CARD_COLORS = ["#FFFFFF", "#FDFDFC"];

export const ProjectsList = ({ projects, currentPage, totalItems, loadNextPage, pageSize, onDeleteProject }) => {
  return (
    <>
      <Elem name="list">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} onDeleteProject={onDeleteProject} />
        ))}
      </Elem>
      <Elem name="pages">
        <Pagination
          name="projects-list"
          label="Projects"
          page={currentPage}
          totalItems={totalItems}
          urlParamName="page"
          pageSize={pageSize}
          pageSizeOptions={[10, 30, 50, 100]}
          onPageLoad={(page, pageSize) => loadNextPage(page, pageSize)}
        />
      </Elem>
    </>
  );
};

export const EmptyProjectsList = ({ openModal }) => {
  return (
    <Block name="empty-projects-page">
      <Elem name="heidi" tag="img" src={absoluteURL("/static/images/opossum_looking.png")} />
      <Elem name="header" tag="h1">
        Heidi doesn’t see any projects here!
      </Elem>
      <p>Create one and start labeling your data.</p>
      <Button onClick={openModal} className="my-8" aria-label="Create new project">
        Create Project
      </Button>
    </Block>
  );
};

const ProjectCard = ({ project, onDeleteProject }) => {
  const api = useContext(ApiContext);
  const toast = useToast();

  const color = useMemo(() => {
    return DEFAULT_CARD_COLORS.includes(project.color) ? null : project.color;
  }, [project]);

  const projectColors = useMemo(() => {
    const textColor =
      color && chr(color).luminance() > 0.3
        ? "var(--color-neutral-inverted-content)"
        : "var(--color-neutral-inverted-content)"; // Determine text color based on luminance
    return color
      ? {
          "--header-color": color,
          "--background-color": chr(color).alpha(0.2).css(),
          "--text-color": textColor,
          "--border-color": chr(color).alpha(0.5).css(),
        }
      : {};
  }, [color]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();

    const isDev = process.env.NODE_ENV === "development";

    modal({
      title: "Delete Project",
      width: 600,
      allowClose: false,
      body: () => {
        const ctrl = useModalControls();
        const inputValue = ctrl?.state?.inputValue || "";

        return (
          <div>
            <p style={{ marginBottom: 16 }}>
              You are about to delete the project <strong>{project.title}</strong>. This action cannot be undone.
            </p>
            <Input
              label='To proceed, type "delete" in the field below:'
              value={inputValue}
              onChange={(e) => ctrl?.setState({ inputValue: e.target.value })}
              autoFocus
              autoComplete="off"
            />
          </div>
        );
      },
      footer: () => {
        const ctrl = useModalControls();
        const inputValue = (ctrl?.state?.inputValue || "").trim().toLowerCase();
        const isValid = isDev || inputValue === "delete";

        return (
          <Space align="end">
            <Button
              variant="neutral"
              look="outline"
              onClick={() => ctrl?.hide()}
            >
              Cancel
            </Button>
            <Button
              variant="negative"
              disabled={!isValid}
              onClick={async () => {
                try {
                  await api.callApi("deleteProject", {
                    params: { pk: project.id },
                  });
                  toast.show({ message: "Project deleted successfully" });
                  ctrl?.hide();
                  onDeleteProject?.();
                } catch (error) {
                  toast.show({ message: `Error: ${error.message}`, type: "error" });
                }
              }}
            >
              Delete Project
            </Button>
          </Space>
        );
      },
    });
  }, [project, api, toast, onDeleteProject]);

  return (
    <Elem tag={NavLink} name="link" to={`/projects/${project.id}/data`} data-external>
      <Block name="project-card" mod={{ colored: !!color }} style={projectColors}>
        <Elem name="header">
          <Elem name="title">
            <Elem name="title-text">{project.title ?? "New project"}</Elem>

            <Elem
              name="menu"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
            >
              <Dropdown.Trigger
                content={
                  <Menu contextual>
                    <Menu.Item href={`/projects/${project.id}/settings`}>Settings</Menu.Item>
                    <Menu.Item href={`/projects/${project.id}/data?labeling=1`}>Label</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={handleDelete} style={{ color: "var(--color-negative-content)" }}>
                      Delete
                    </Menu.Item>
                  </Menu>
                }
              >
                <Button size="smaller" look="string" aria-label="Project options">
                  <IconEllipsis />
                </Button>
              </Dropdown.Trigger>
            </Elem>
          </Elem>
          <Elem name="summary">
            <Elem name="annotation">
              <Elem name="total">
                {project.finished_task_number} / {project.task_number}
              </Elem>
              <Elem name="detail">
                <Elem name="detail-item" mod={{ type: "completed" }}>
                  <Elem tag={IconCheck} name="icon" />
                  {project.total_annotations_number}
                </Elem>
                <Elem name="detail-item" mod={{ type: "rejected" }}>
                  <Elem tag={IconMinus} name="icon" />
                  {project.skipped_annotations_number}
                </Elem>
                <Elem name="detail-item" mod={{ type: "predictions" }}>
                  <Elem tag={IconSparks} name="icon" />
                  {project.total_predictions_number}
                </Elem>
              </Elem>
            </Elem>
          </Elem>
        </Elem>
        <Elem name="description">{project.description}</Elem>
        <Elem name="info">
          <Elem name="created-date">{format(new Date(project.created_at), "dd MMM 'yy, HH:mm")}</Elem>
          <Elem name="created-by">
            <Userpic src="#" user={project.created_by} showUsername />
          </Elem>
        </Elem>
      </Block>
    </Elem>
  );
};
