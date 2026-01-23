"""This file and its contents are licensed under the Apache License 2.0. Please see the included NOTICE for copyright information and LICENSE for a copy of the license.
"""
import logging
import os
import pathlib

from core.filters import ListFilter
from core.label_config import config_essential_data_has_changed
from core.mixins import GetParentObjectMixin
from core.permissions import ViewClassPermission, all_permissions
from core.redis import start_job_async_or_sync
from core.utils.common import paginator, paginator_help, temporary_disconnect_all_signals
from core.utils.exceptions import LabelStudioDatabaseException, ProjectExistException
from core.utils.filterset_to_openapi_params import filterset_to_openapi_params
from core.utils.io import find_dir, find_file, read_yaml
from core.utils.serializer_to_openapi_params import serializer_to_openapi_params
from data_manager.functions import filters_ordering_selected_items_exist, get_prepared_queryset
from django.conf import settings
from django.db import IntegrityError
from django.db.models import F
from django.http import Http404
from django.utils.decorators import method_decorator
from django_filters import CharFilter, FilterSet
from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiExample, OpenApiParameter, OpenApiResponse, extend_schema
from label_studio_sdk.label_interface.interface import LabelInterface
from ml.serializers import MLBackendSerializer
from projects.functions.next_task import get_next_task
from projects.functions.stream_history import get_label_stream_history
from projects.functions.utils import recalculate_created_annotations_and_labels_from_scratch
from projects.models import Project, ProjectImport, ProjectManager, ProjectReimport, ProjectSummary
from projects.serializers import (
    GetFieldsSerializer,
    ProjectCountsSerializer,
    ProjectImportSerializer,
    ProjectLabelConfigSerializer,
    ProjectModelVersionExtendedSerializer,
    ProjectModelVersionParamsSerializer,
    ProjectQualityMetricsSerializer,
    ProjectReimportSerializer,
    ProjectSerializer,
    ProjectSummarySerializer,
)
from rest_framework import filters, generics, status
from rest_framework.exceptions import NotFound
from rest_framework.exceptions import ValidationError as RestValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.settings import api_settings
from rest_framework.views import exception_handler
from tasks.models import Annotation, Task
from tasks.serializers import (
    NextTaskSerializer,
    TaskSerializer,
    TaskSimpleSerializer,
    TaskWithAnnotationsAndPredictionsAndDraftsSerializer,
)
from users.models import User
from users.serializers import UserSimpleSerializer
from webhooks.models import WebhookAction
from webhooks.utils import api_webhook, api_webhook_for_delete, emit_webhooks_for_instance

from label_studio.core.utils.common import load_func

logger = logging.getLogger(__name__)

ProjectImportPermission = load_func(settings.PROJECT_IMPORT_PERMISSION)

_result_schema = {
    'title': 'Labeling result',
    'description': 'Labeling result (choices, labels, bounding boxes, etc.)',
    'type': 'object',
    'properties': {
        'from_name': {
            'type': 'string',
            'description': 'The name of the labeling tag from the project config',
        },
        'to_name': {
            'type': 'string',
            'description': 'The name of the labeling tag from the project config',
        },
        'value': {
            'type': 'object',
            'description': 'Labeling result value. Format depends on chosen ML backend',
        },
    },
    'example': {'from_name': 'image_class', 'to_name': 'image', 'value': {'labels': ['Cat']}},
}

_task_data_schema = {
    'title': 'Task data',
    'description': 'Task data',
    'type': 'object',
    'example': {'id': 1, 'my_image_url': '/static/samples/kittens.jpg'},
}


class ProjectListPagination(PageNumberPagination):
    page_size = 30
    page_size_query_param = 'page_size'
    max_page_size = 100


class ProjectFilterSet(FilterSet):
    ids = ListFilter(field_name='id', lookup_expr='in')
    title = CharFilter(field_name='title', lookup_expr='icontains')


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Projects'],
        summary='List your projects',
        description="""
    Return a list of the projects that you've created.

    To perform most tasks with the Label Studio API, you must specify the project ID, sometimes referred to as the `pk`.
    To retrieve a list of your Label Studio projects, update the following command to match your own environment.
    Replace the domain name, port, and authorization token, then run the following from the command line:
    ```bash
    curl -X GET {}/api/projects/ -H 'Authorization: Token abc123'
    ```
    """.format(
            settings.HOSTNAME or 'https://localhost:8080'
        ),
        parameters=[
            *serializer_to_openapi_params(GetFieldsSerializer),
            *filterset_to_openapi_params(ProjectFilterSet),
        ],
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'counts',
            'x-fern-audiences': ['public'],
            'x-fern-pagination': {
                'offset': '$request.page',
                'results': '$response.results',
            },
        },
    ),
)
@method_decorator(
    name='post',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Create new project',
        description="""
    Create a project and set up the labeling interface in Label Studio using the API.

    ```bash
    curl -H Content-Type:application/json -H 'Authorization: Token abc123' -X POST '{}/api/projects' \
    --data '{{"title": "My project", "label_config": "<View></View>"}}'
    ```
    """.format(
            settings.HOSTNAME or 'https://localhost:8080'
        ),
        request=ProjectSerializer,
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'create',
            'x-fern-audiences': ['public'],
        },
    ),
)
class ProjectListAPI(generics.ListCreateAPIView):
    parser_classes = (JSONParser, FormParser, MultiPartParser)
    serializer_class = ProjectSerializer
    filter_backends = [filters.OrderingFilter, DjangoFilterBackend]
    filterset_class = ProjectFilterSet
    permission_required = ViewClassPermission(
        GET=all_permissions.projects_view,
        POST=all_permissions.projects_create,
    )
    pagination_class = ProjectListPagination

    def get_queryset(self):
        serializer = GetFieldsSerializer(data=self.request.query_params)
        serializer.is_valid(raise_exception=True)
        fields = serializer.validated_data.get('include')
        filter = serializer.validated_data.get('filter')
        projects = Project.objects.filter(organization=self.request.user.active_organization).order_by(
            F('pinned_at').desc(nulls_last=True), '-created_at'
        )
        if filter in ['pinned_only', 'exclude_pinned']:
            projects = projects.filter(pinned_at__isnull=filter == 'exclude_pinned')
        return ProjectManager.with_counts_annotate(projects, fields=fields).prefetch_related('members', 'created_by')

    def get_serializer_context(self):
        context = super(ProjectListAPI, self).get_serializer_context()
        context['created_by'] = self.request.user
        return context

    def perform_create(self, ser):
        try:
            ser.save(organization=self.request.user.active_organization)
        except IntegrityError as e:
            if str(e) == 'UNIQUE constraint failed: project.title, project.created_by_id':
                raise ProjectExistException(
                    'Project with the same name already exists: {}'.format(ser.validated_data.get('title', ''))
                )
            raise LabelStudioDatabaseException('Database error during project creation. Try again.')

    def get(self, request, *args, **kwargs):
        return super(ProjectListAPI, self).get(request, *args, **kwargs)

    @api_webhook(WebhookAction.PROJECT_CREATED)
    def post(self, request, *args, **kwargs):
        return super(ProjectListAPI, self).post(request, *args, **kwargs)


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Projects'],
        summary="List projects' counts",
        parameters=[
            *serializer_to_openapi_params(GetFieldsSerializer),
            *filterset_to_openapi_params(ProjectFilterSet),
        ],
        description='Returns a list of projects with their counts. For example, task_number which is the total task number in project',
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'list_counts',
            'x-fern-audiences': ['public'],
        },
    ),
)
class ProjectCountsListAPI(generics.ListAPIView):
    serializer_class = ProjectCountsSerializer
    filterset_class = ProjectFilterSet
    permission_required = ViewClassPermission(
        GET=all_permissions.projects_view,
    )
    pagination_class = ProjectListPagination

    def get_queryset(self):
        serializer = GetFieldsSerializer(data=self.request.query_params)
        serializer.is_valid(raise_exception=True)
        fields = serializer.validated_data.get('include')
        return Project.objects.with_counts(fields=fields).filter(organization=self.request.user.active_organization)


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Get project by ID',
        description='Retrieve information about a project by project ID.',
        responses={
            '200': OpenApiResponse(
                description='Project information',
                response=ProjectSerializer,
                examples=[
                    OpenApiExample(
                        name='response',
                        value={
                            'id': 1,
                            'title': 'My project',
                            'description': 'My first project',
                            'label_config': '<View>[...]</View>',
                            'expert_instruction': 'Label all cats',
                            'show_instruction': True,
                            'show_skip_button': True,
                            'enable_empty_annotation': True,
                            'show_annotation_history': True,
                            'organization': 1,
                            'color': '#FF0000',
                            'maximum_annotations': 1,
                            'is_published': True,
                            'model_version': '1.0.0',
                            'is_draft': False,
                            'created_by': {
                                'id': 1,
                                'first_name': 'Jo',
                                'last_name': 'Doe',
                                'email': 'manager@humansignal.com',
                            },
                            'created_at': '2023-08-24T14:15:22Z',
                            'min_annotations_to_start_training': 0,
                            'start_training_on_annotation_update': True,
                            'show_collab_predictions': True,
                            'num_tasks_with_annotations': 10,
                            'task_number': 100,
                            'useful_annotation_number': 10,
                            'ground_truth_number': 5,
                            'skipped_annotations_number': 0,
                            'total_annotations_number': 10,
                            'total_predictions_number': 0,
                            'sampling': 'Sequential sampling',
                            'show_ground_truth_first': True,
                            'show_overlap_first': True,
                            'overlap_cohort_percentage': 100,
                            'task_data_login': 'user',
                            'task_data_password': 'secret',
                            'control_weights': {},
                            'parsed_label_config': '{"tag": {...}}',
                            'evaluate_predictions_automatically': False,
                            'config_has_control_tags': True,
                            'skip_queue': 'REQUEUE_FOR_ME',
                            'reveal_preannotations_interactively': True,
                            'pinned_at': '2023-08-24T14:15:22Z',
                            'finished_task_number': 10,
                            'queue_total': 10,
                            'queue_done': 100,
                        },
                        media_type='application/json',
                    )
                ],
            )
        },
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'get',
            'x-fern-audiences': ['public'],
        },
    ),
)
@method_decorator(
    name='delete',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Delete project',
        description='Delete a project by specified project ID.',
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'delete',
            'x-fern-audiences': ['public'],
        },
    ),
)
@method_decorator(
    name='patch',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Update project',
        description='Update the project settings for a specific project.',
        request=ProjectSerializer,
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'update',
            'x-fern-audiences': ['public'],
        },
    ),
)
class ProjectAPI(generics.RetrieveUpdateDestroyAPIView):
    parser_classes = (JSONParser, FormParser, MultiPartParser)
    queryset = Project.objects.with_counts()
    permission_required = ViewClassPermission(
        GET=all_permissions.projects_view,
        DELETE=all_permissions.projects_delete,
        PATCH=all_permissions.projects_change,
        PUT=all_permissions.projects_change,
        POST=all_permissions.projects_create,
    )
    serializer_class = ProjectSerializer

    redirect_route = 'projects:project-detail'
    redirect_kwarg = 'pk'

    def get_queryset(self):
        serializer = GetFieldsSerializer(data=self.request.query_params)
        serializer.is_valid(raise_exception=True)
        fields = serializer.validated_data.get('include')
        return Project.objects.with_counts(fields=fields).filter(organization=self.request.user.active_organization)

    def get(self, request, *args, **kwargs):
        return super(ProjectAPI, self).get(request, *args, **kwargs)

    @api_webhook_for_delete(WebhookAction.PROJECT_DELETED)
    def delete(self, request, *args, **kwargs):
        return super(ProjectAPI, self).delete(request, *args, **kwargs)

    @api_webhook(WebhookAction.PROJECT_UPDATED)
    def patch(self, request, *args, **kwargs):
        project = self.get_object()
        label_config = self.request.data.get('label_config')

        # config changes can break view, so we need to reset them
        if label_config:
            try:
                _has_changes = config_essential_data_has_changed(label_config, project.label_config)
            except KeyError:
                pass

        return super(ProjectAPI, self).patch(request, *args, **kwargs)

    def perform_destroy(self, instance):
        # we don't need to relaculate counters if we delete whole project
        with temporary_disconnect_all_signals():
            instance.delete()

    @extend_schema(exclude=True)
    @api_webhook(WebhookAction.PROJECT_UPDATED)
    def put(self, request, *args, **kwargs):
        return super(ProjectAPI, self).put(request, *args, **kwargs)


# @method_decorator(
#     name='get',
#     decorator=extend_schema(
#         tags=['Projects'],
#         summary='Get next task to label',
#         description="""
#     Get the next task for labeling. If you enable Machine Learning in
#     your project, the response might include a "predictions"
#     field. It contains a machine learning prediction result for
#     this task.
#     """,
#         responses={200: TaskWithAnnotationsAndPredictionsAndDraftsSerializer()},
#     ),
# )
# leaving this method decorator info in case we put it back in swagger API docs
@extend_schema(exclude=True)
class ProjectNextTaskAPI(generics.RetrieveAPIView):
    permission_required = all_permissions.tasks_view
    serializer_class = TaskWithAnnotationsAndPredictionsAndDraftsSerializer
    queryset = Project.objects.all()

    def get(self, request, *args, **kwargs):
        project = self.get_object()
        dm_queue = filters_ordering_selected_items_exist(request.data)
        prepared_tasks = get_prepared_queryset(request, project)

        next_task, queue_info = get_next_task(request.user, prepared_tasks, project, dm_queue)

        if next_task is None:
            raise NotFound(f'There are no tasks for {request.user}')

        # serialize task
        context = {'request': request, 'project': project, 'resolve_uri': True, 'annotations': False}
        serializer = NextTaskSerializer(next_task, context=context)
        response = serializer.data

        response['queue'] = queue_info
        return Response(response)


@extend_schema(exclude=True)
class LabelStreamHistoryAPI(generics.RetrieveAPIView):
    permission_required = all_permissions.tasks_view
    queryset = Project.objects.all()

    def get(self, request, *args, **kwargs):
        project = self.get_object()

        history = get_label_stream_history(request.user, project)

        return Response(history)


@method_decorator(
    name='post',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Validate label config',
        description='Validate an arbitrary labeling configuration.',
        responses={
            204: OpenApiResponse(description='Validation success'),
            400: OpenApiResponse(description='Validation failed'),
        },
        request=ProjectLabelConfigSerializer,
        extensions={
            'x-fern-audiences': ['internal'],
        },
    ),
)
class LabelConfigValidateAPI(generics.CreateAPIView):
    parser_classes = (JSONParser, FormParser, MultiPartParser)
    permission_classes = (AllowAny,)
    serializer_class = ProjectLabelConfigSerializer

    def post(self, request, *args, **kwargs):
        return super(LabelConfigValidateAPI, self).post(request, *args, **kwargs)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        try:
            serializer.is_valid(raise_exception=True)
        except RestValidationError as exc:
            context = self.get_exception_handler_context()
            response = exception_handler(exc, context)
            response = self.finalize_response(request, response)
            return response

        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(
    name='post',
    decorator=extend_schema(
        tags=['Projects'],
        operation_id='api_projects_validate_label_config',
        summary='Validate project label config',
        description='Determine whether the label configuration for a specific project is valid.',
        parameters=[
            OpenApiParameter(
                name='id',
                type=OpenApiTypes.INT,
                location='path',
                description='A unique integer value identifying this project.',
            ),
        ],
        request=ProjectLabelConfigSerializer,
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'validate_label_config',
            'x-fern-audiences': ['public'],
        },
    ),
)
class ProjectLabelConfigValidateAPI(generics.RetrieveAPIView):
    """Validate label config"""

    parser_classes = (JSONParser, FormParser, MultiPartParser)
    serializer_class = ProjectLabelConfigSerializer
    permission_required = all_permissions.projects_change
    queryset = Project.objects.all()

    def post(self, request, *args, **kwargs):
        project = self.get_object()
        label_config = self.request.data.get('label_config')
        if not label_config:
            raise RestValidationError('Label config is not set or is empty')

        # check new config includes meaningful changes
        has_changed = config_essential_data_has_changed(label_config, project.label_config)
        project.validate_config(label_config, strict=True)
        return Response({'config_essential_data_has_changed': has_changed}, status=status.HTTP_200_OK)

    @extend_schema(exclude=True)
    def get(self, request, *args, **kwargs):
        return super(ProjectLabelConfigValidateAPI, self).get(request, *args, **kwargs)


class ProjectSummaryAPI(generics.RetrieveAPIView):
    parser_classes = (JSONParser,)
    serializer_class = ProjectSummarySerializer
    permission_required = all_permissions.projects_view
    queryset = ProjectSummary.objects.all()

    @extend_schema(exclude=True)
    def get(self, *args, **kwargs):
        return super(ProjectSummaryAPI, self).get(*args, **kwargs)


class ProjectSummaryResetAPI(GetParentObjectMixin, generics.CreateAPIView):
    """This API is useful when we need to reset project.summary.created_labels and created_labels_drafts
    and recalculate them from scratch. It's hard to correctly follow all changes in annotation region
    labels and these fields aren't calculated properly after some time. Label config changes are not allowed
    when these changes touch any labels from these created_labels* dictionaries.
    """

    parser_classes = (JSONParser,)
    parent_queryset = Project.objects.all()
    permission_required = ViewClassPermission(
        POST=all_permissions.projects_change,
    )

    @extend_schema(exclude=True)
    def post(self, *args, **kwargs):
        project = self.parent_object
        summary = project.summary
        start_job_async_or_sync(
            recalculate_created_annotations_and_labels_from_scratch,
            project,
            summary,
            organization_id=self.request.user.active_organization.id,
        )
        return Response(status=status.HTTP_200_OK)


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Get project import info',
        description='Return data related to async project import operation',
        parameters=[
            OpenApiParameter(
                name='id',
                type=OpenApiTypes.INT,
                location='path',
                description='A unique integer value identifying this project import.',
            ),
        ],
        extensions={
            'x-fern-sdk-group-name': 'tasks',
            'x-fern-sdk-method-name': 'create_many_status',
            'x-fern-audiences': ['public'],
        },
    ),
)
class ProjectImportAPI(generics.RetrieveAPIView):
    permission_required = all_permissions.projects_change
    permission_classes = api_settings.DEFAULT_PERMISSION_CLASSES + [ProjectImportPermission]
    parser_classes = (JSONParser,)
    serializer_class = ProjectImportSerializer
    queryset = ProjectImport.objects.all()
    lookup_url_kwarg = 'import_pk'


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Get project reimport info',
        description='Return data related to async project reimport operation',
        parameters=[
            OpenApiParameter(
                name='id',
                type=OpenApiTypes.INT,
                location='path',
                description='A unique integer value identifying this project reimport.',
            ),
        ],
        extensions={
            'x-fern-audiences': ['internal'],
        },
    ),
)
class ProjectReimportAPI(generics.RetrieveAPIView):
    permission_required = all_permissions.projects_change
    permission_classes = api_settings.DEFAULT_PERMISSION_CLASSES + [ProjectImportPermission]
    parser_classes = (JSONParser,)
    serializer_class = ProjectReimportSerializer
    queryset = ProjectReimport.objects.all()
    lookup_url_kwarg = 'reimport_pk'


@method_decorator(
    name='delete',
    decorator=extend_schema(
        tags=['Projects'],
        summary='Delete all tasks',
        description='Delete all tasks from a specific project.',
        parameters=[
            OpenApiParameter(
                name='id',
                type=OpenApiTypes.INT,
                location='path',
                description='A unique integer value identifying this project.',
            ),
        ],
        extensions={
            'x-fern-sdk-group-name': 'tasks',
            'x-fern-sdk-method-name': 'delete_all_tasks',
            'x-fern-audiences': ['public'],
        },
    ),
)
@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Projects'],  # TODO: deprecate this endpoint in favor of tasks:tasks-list
        summary='List project tasks',
        description="""
            Retrieve a paginated list of tasks for a specific project. For example, use the following cURL command:
            ```bash
            curl -X GET {}/api/projects/{{id}}/tasks/?page=1&page_size=10 -H 'Authorization: Token abc123'
            ```
        """.format(
            settings.HOSTNAME or 'https://localhost:8080'
        ),
        parameters=[
            OpenApiParameter(
                name='id',
                type=OpenApiTypes.INT,
                location='path',
                description='A unique integer value identifying this project.',
            ),
        ]
        + paginator_help('tasks', 'Projects')['parameters'],
        extensions={
            'x-fern-audiences': ['internal'],  # TODO: deprecate this endpoint in favor of tasks:tasks-list
        },
    ),
)
class ProjectTaskListAPI(GetParentObjectMixin, generics.ListCreateAPIView, generics.DestroyAPIView):
    parser_classes = (JSONParser, FormParser)
    queryset = Task.objects.all()
    parent_queryset = Project.objects.all()
    permission_required = ViewClassPermission(
        GET=all_permissions.tasks_view,
        POST=all_permissions.tasks_change,
        DELETE=all_permissions.tasks_delete,
    )
    serializer_class = TaskSerializer
    redirect_route = 'projects:project-settings'
    redirect_kwarg = 'pk'

    def get_serializer_class(self):
        if self.request.method == 'GET':
            return TaskSimpleSerializer
        else:
            return TaskSerializer

    def filter_queryset(self, queryset):
        project = generics.get_object_or_404(Project.objects.for_user(self.request.user), pk=self.kwargs.get('pk', 0))
        # ordering is deprecated here
        tasks = Task.objects.filter(project=project).order_by('-updated_at')
        page = paginator(tasks, self.request)
        if page:
            return page
        else:
            raise Http404

    def delete(self, request, *args, **kwargs):
        project = generics.get_object_or_404(Project.objects.for_user(self.request.user), pk=self.kwargs['pk'])
        task_ids = list(Task.objects.filter(project=project).values('id'))
        Task.delete_tasks_without_signals(Task.objects.filter(project=project))
        logger.info(f'calling reset project_id={project.id} ProjectTaskListAPI.delete()')
        project.summary.reset()
        emit_webhooks_for_instance(request.user.active_organization, None, WebhookAction.TASKS_DELETED, task_ids)
        return Response(status=204)

    def get(self, *args, **kwargs):
        return super(ProjectTaskListAPI, self).get(*args, **kwargs)

    @extend_schema(exclude=True)
    def post(self, *args, **kwargs):
        return super(ProjectTaskListAPI, self).post(*args, **kwargs)

    def get_serializer_context(self):
        context = super(ProjectTaskListAPI, self).get_serializer_context()
        context['project'] = self.parent_object
        return context

    def perform_create(self, serializer):
        project = self.parent_object
        instance = serializer.save(project=project)
        emit_webhooks_for_instance(
            self.request.user.active_organization, project, WebhookAction.TASKS_CREATED, [instance]
        )
        return instance


def read_templates_and_groups():
    annotation_templates_dir = find_dir('annotation_templates')
    configs = []
    for config_file in pathlib.Path(annotation_templates_dir).glob('**/*.yml'):
        config = read_yaml(config_file)

        if settings.VERSION_EDITION != 'Community':
            if config.get('group', '').lower() == 'community contributions':
                continue

        if settings.VERSION_EDITION == 'Community':
            if config.get('type', 'community').lower() != 'community':
                continue

        if config.get('image', '').startswith('/static') and settings.HOSTNAME:
            # if hostname set manually, create full image urls
            config['image'] = settings.HOSTNAME + config['image']
        configs.append(config)
    template_groups_file = find_file(os.path.join('annotation_templates', 'groups.txt'))
    with open(template_groups_file, encoding='utf-8') as f:
        groups = f.read().splitlines()

    if settings.VERSION_EDITION != 'Community':
        groups = [group for group in groups if group.lower() != 'community contributions']

    logger.debug(f'{len(configs)} templates found.')
    return {'templates': configs, 'groups': groups}


@extend_schema(exclude=True)
class TemplateListAPI(generics.ListAPIView):
    parser_classes = (JSONParser, FormParser, MultiPartParser)
    permission_required = all_permissions.projects_view
    # load this once in memory for performance
    templates_and_groups = read_templates_and_groups()

    def list(self, request, *args, **kwargs):
        return Response(self.templates_and_groups)


@extend_schema(exclude=True)
class ProjectSampleTask(generics.RetrieveAPIView):
    parser_classes = (JSONParser,)
    queryset = Project.objects.all()
    permission_required = all_permissions.projects_view
    serializer_class = ProjectSerializer

    def post(self, request, *args, **kwargs):
        label_config = self.request.data.get('label_config')
        include_annotation_and_prediction = self.request.data.get('include_annotation_and_prediction', False)

        if not label_config:
            raise RestValidationError('Label config is not set or is empty')

        project = self.get_object()

        if include_annotation_and_prediction:
            try:
                label_interface = LabelInterface(label_config)
                complete_task = label_interface.generate_complete_sample_task(raise_on_failure=True)
                # set the annotation's user id to the current user instead of -1
                user_id = request.user.id
                for annotation in complete_task['annotations']:
                    annotation['completed_by'] = user_id
                return Response({'sample_task': complete_task}, status=200)
            except Exception as e:
                logger.error(
                    f'Error generating enhanced sample task, falling back to original method: {str(e)}. Label config: {label_config}'
                )
                # Fallback to project.get_sample_task if LabelInterface.generate_complete_sample_task failed
                return Response({'sample_task': project.get_sample_task(label_config)}, status=200)
        else:
            # Use the simple sample task generation method
            return Response({'sample_task': project.get_sample_task(label_config)}, status=200)


@extend_schema(exclude=True)
class ProjectModelVersions(generics.RetrieveAPIView):
    parser_classes = (JSONParser,)
    permission_required = all_permissions.projects_view

    def get_queryset(self):
        return Project.objects.filter(organization=self.request.user.active_organization)

    def get(self, request, *args, **kwargs):
        project = self.get_object()
        serializer = ProjectModelVersionParamsSerializer(data=self.request.query_params)
        serializer.is_valid(raise_exception=True)
        extended = serializer.validated_data.get('extended', False)
        include_live_models = serializer.validated_data.get('include_live_models', False)
        limit = serializer.validated_data.get('limit', None)
        data = project.get_model_versions(with_counters=True, extended=extended, limit=limit)

        if extended:
            serializer_models = None
            serializer = ProjectModelVersionExtendedSerializer(data, many=True)

            if include_live_models:
                ml_models = project.get_ml_backends()
                serializer_models = MLBackendSerializer(ml_models, many=True)

            return Response({'static': serializer.data, 'live': serializer_models and serializer_models.data})
        else:
            return Response(data=data)

    def delete(self, request, *args, **kwargs):
        project = self.get_object()
        model_version = request.data.get('model_version', None)

        if not model_version:
            raise RestValidationError('model_version param is required')

        count = project.delete_predictions(model_version=model_version)

        return Response(data=count)


@method_decorator(
    name='get',
    decorator=extend_schema(
        tags=['Projects'],
        summary='List unique annotators for project',
        description='Return unique users who have submitted annotations in the specified project.',
        responses={
            200: OpenApiResponse(
                description='List of annotator users',
                response=UserSimpleSerializer(many=True),
            )
        },
        extensions={
            'x-fern-sdk-group-name': 'projects',
            'x-fern-sdk-method-name': 'list_unique_annotators',
            'x-fern-audiences': ['public'],
        },
    ),
)
class ProjectAnnotatorsAPI(generics.RetrieveAPIView):
    permission_required = all_permissions.projects_view
    queryset = Project.objects.all()

    def get(self, request, *args, **kwargs):
        project = self.get_object()
        annotator_ids = list(
            Annotation.objects.filter(project=project, completed_by_id__isnull=False)
            .values_list('completed_by_id', flat=True)
            .distinct()
        )
        users = User.objects.filter(id__in=annotator_ids).prefetch_related('om_through').order_by('id')
        data = UserSimpleSerializer(users, many=True, context={'request': request}).data
        return Response(data)


class ProjectQualityMetricsAPI(GetParentObjectMixin, generics.RetrieveAPIView):
    """API endpoint for retrieving project quality metrics"""
    
    parser_classes = (JSONParser,)
    parent_queryset = Project.objects.all()
    permission_required = all_permissions.projects_view
    serializer_class = ProjectQualityMetricsSerializer

    @extend_schema(
        tags=['Projects'],
        summary='Get project quality metrics',
        description='Retrieve comprehensive quality metrics for a project including annotation statistics, lead times, and completion rates',
        responses={200: ProjectQualityMetricsSerializer}
    )
    def get(self, request, *args, **kwargs):
        from django.db.models import Avg, Count, Max, Min, Q
        from django.db.models.functions import TruncDate
        import statistics
        import math
        
        project = self.parent_object
        
        # Get all annotations for the project
        annotations = Annotation.objects.filter(project=project)
        completed_annotations = annotations.filter(was_cancelled=False)
        skipped_annotations = annotations.filter(was_cancelled=True)
        ground_truth_annotations = annotations.filter(ground_truth=True)
        
        # Calculate basic metrics
        total_annotations = annotations.count()
        total_tasks = project.tasks.count()
        completed_count = completed_annotations.count()
        skipped_count = skipped_annotations.count()
        ground_truth_count = ground_truth_annotations.count()
        
        # Calculate lead time metrics - with safe handling
        lead_times = list(completed_annotations.filter(
            lead_time__isnull=False,
            lead_time__gt=0
        ).values_list('lead_time', flat=True))
        
        # Filter out any invalid values (inf, -inf, nan)
        lead_times = [lt for lt in lead_times if math.isfinite(lt)]
        
        avg_lead_time = sum(lead_times) / len(lead_times) if lead_times else 0.0
        median_lead_time = statistics.median(lead_times) if lead_times else 0.0
        
        # Calculate annotations per task
        annotations_per_task = total_annotations / total_tasks if total_tasks > 0 else 0.0
        
        # Calculate completion rate
        completed_tasks = project.tasks.filter(is_labeled=True).count()
        completion_rate = (completed_tasks / total_tasks * 100.0) if total_tasks > 0 else 0.0
        
        # Get unique annotators count
        annotators_count = annotations.filter(completed_by__isnull=False).values('completed_by').distinct().count()
        
        # Annotations by user
        annotations_by_user = list(
            annotations.filter(completed_by__isnull=False)
            .values('completed_by__email', 'completed_by__first_name', 'completed_by__last_name')
            .annotate(
                count=Count('id'),
                avg_time=Avg('lead_time'),
                skipped=Count('id', filter=Q(was_cancelled=True)),
                completed=Count('id', filter=Q(was_cancelled=False))
            )
            .order_by('-count')[:20]
        )
        
        # Format user data and handle None/invalid values
        for user_data in annotations_by_user:
            user_data['name'] = f"{user_data.pop('completed_by__first_name', '')} {user_data.pop('completed_by__last_name', '')}".strip() or user_data.get('completed_by__email', 'Unknown')
            user_data.pop('completed_by__email', None)
            # Ensure avg_time is a valid number
            if user_data.get('avg_time') is None or not math.isfinite(user_data.get('avg_time', 0) or 0):
                user_data['avg_time'] = 0.0
            else:
                user_data['avg_time'] = float(user_data['avg_time'])
        
        # Annotations over time (last 30 days)
        from datetime import timedelta
        from django.utils.timezone import now
        
        thirty_days_ago = now() - timedelta(days=30)
        annotations_over_time = list(
            annotations.filter(created_at__gte=thirty_days_ago)
            .annotate(date=TruncDate('created_at'))
            .values('date')
            .annotate(
                count=Count('id'),
                completed=Count('id', filter=Q(was_cancelled=False)),
                skipped=Count('id', filter=Q(was_cancelled=True))
            )
            .order_by('date')
        )
        
        # Convert dates to strings
        for item in annotations_over_time:
            item['date'] = item['date'].isoformat() if item['date'] else None
        
        # Lead time distribution (buckets)
        lead_time_buckets = [
            {'range': '0-30s', 'count': 0},
            {'range': '30s-1m', 'count': 0},
            {'range': '1-2m', 'count': 0},
            {'range': '2-5m', 'count': 0},
            {'range': '5-10m', 'count': 0},
            {'range': '10m+', 'count': 0},
        ]
        
        # Categorize lead times into buckets
        for lead_time in lead_times:
            if lead_time < 30:
                lead_time_buckets[0]['count'] += 1
            elif lead_time < 60:
                lead_time_buckets[1]['count'] += 1
            elif lead_time < 120:
                lead_time_buckets[2]['count'] += 1
            elif lead_time < 300:
                lead_time_buckets[3]['count'] += 1
            elif lead_time < 600:
                lead_time_buckets[4]['count'] += 1
            else:
                lead_time_buckets[5]['count'] += 1
        
        # Recent annotations (last 10)
        recent_annotations = list(
            annotations.select_related('task', 'completed_by')
            .order_by('-created_at')[:10]
            .values(
                'id',
                'created_at',
                'lead_time',
                'was_cancelled',
                'ground_truth',
                'completed_by__email',
                'completed_by__first_name',
                'completed_by__last_name',
                'task_id',
                'result_count'
            )
        )
        
        # Format recent annotations and handle None/invalid values
        for ann in recent_annotations:
            ann['created_at'] = ann['created_at'].isoformat() if ann['created_at'] else None
            ann['annotator'] = f"{ann.pop('completed_by__first_name', '')} {ann.pop('completed_by__last_name', '')}".strip() or ann.pop('completed_by__email', 'Unknown')
            # Ensure lead_time is a valid number
            if ann.get('lead_time') is None or not math.isfinite(ann.get('lead_time', 0) or 0):
                ann['lead_time'] = 0.0
            else:
                ann['lead_time'] = float(ann['lead_time'])
        
        # Task completion status
        task_completion_status = {
            'total': total_tasks,
            'completed': completed_tasks,
            'in_progress': project.tasks.filter(total_annotations__gt=0, is_labeled=False).count(),
            'not_started': project.tasks.filter(total_annotations=0).count(),
        }
        
        # Ensure all float values are finite before returning
        def safe_float(value, default=0.0):
            """Ensure float is finite and JSON-compliant"""
            if value is None:
                return default
            try:
                f = float(value)
                return f if math.isfinite(f) else default
            except (ValueError, TypeError):
                return default
        
        data = {
            'total_annotations': int(total_annotations),
            'total_tasks': int(total_tasks),
            'completed_annotations': int(completed_count),
            'skipped_annotations': int(skipped_count),
            'ground_truth_annotations': int(ground_truth_count),
            'avg_lead_time': round(safe_float(avg_lead_time), 2),
            'median_lead_time': round(safe_float(median_lead_time), 2),
            'annotations_per_task': round(safe_float(annotations_per_task), 2),
            'completion_rate': round(safe_float(completion_rate), 2),
            'annotators_count': int(annotators_count),
            'annotations_by_user': annotations_by_user,
            'annotations_over_time': annotations_over_time,
            'lead_time_distribution': lead_time_buckets,
            'recent_annotations': recent_annotations,
            'task_completion_status': task_completion_status,
        }
        
        serializer = self.serializer_class(data)
        return Response(serializer.data)
