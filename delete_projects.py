#!/usr/bin/env python3
"""
Label Studio Batch Project Deletion Script

Usage:
1. Delete projects by specific IDs:
   python delete_projects.py --ids 1 2 3

2. Delete projects by names:
   python delete_projects.py --names "Project 1" "Project 2"

3. Delete all projects (requires confirmation):
   python delete_projects.py --all

4. Delete by name pattern (supports regex):
   python delete_projects.py --pattern "test.*"

5. Delete projects in ID range:
   python delete_projects.py --range 1 10

6. List all projects (no deletion):
   python delete_projects.py --list
"""

import argparse
import os
import re
import sys
from typing import List, Optional

try:
    from label_studio_sdk.client import LabelStudio
except ImportError:
    print("Error: label-studio-sdk is not installed")
    print("Run: pip install label-studio-sdk")
    sys.exit(1)


def get_project_attr(project, attr: str, default=None):
    """
    Safely get project attribute, supports both dict and object access
    """
    if isinstance(project, dict):
        return project.get(attr, default)
    else:
        return getattr(project, attr, default)


def get_client(url: Optional[str] = None, api_key: Optional[str] = None) -> LabelStudio:
    """
    Create Label Studio client
    
    Args:
        url: Label Studio server URL, defaults to LABEL_STUDIO_URL env var
        api_key: API key, defaults to LABEL_STUDIO_API_KEY env var
    """
    url = url or os.getenv('LABEL_STUDIO_URL', 'http://localhost:8080')
    api_key = api_key or os.getenv('LABEL_STUDIO_API_KEY')
    
    if not api_key:
        print("Error: No API Key provided")
        print("Please set LABEL_STUDIO_API_KEY environment variable or use --api-key argument")
        sys.exit(1)
    
    print(f"Connecting to Label Studio: {url}")
    return LabelStudio(base_url=url, api_key=api_key)


def list_projects(client: LabelStudio, pattern: Optional[str] = None):
    """List all projects"""
    try:
        # Convert paginator object to list
        projects = list(client.projects.list())
        
        if not projects:
            print("No projects found")
            return []
        
        print(f"\nFound {len(projects)} project(s):")
        print("-" * 80)
        print(f"{'ID':<8} {'Title':<40} {'Tasks':<10}")
        print("-" * 80)
        
        filtered_projects = []
        for project in projects:
            # Get project attributes
            project_id = get_project_attr(project, 'id', 'N/A')
            project_title = get_project_attr(project, 'title', 'Untitled')
            task_count = get_project_attr(project, 'task_number', 0)
            
            # Filter by pattern if specified
            if pattern:
                if not re.search(pattern, project_title, re.IGNORECASE):
                    continue
            
            filtered_projects.append(project)
            print(f"{project_id:<8} {project_title:<40} {task_count:<10}")
        
        print("-" * 80)
        return filtered_projects
    
    except Exception as e:
        print(f"Error: Failed to get project list: {e}")
        sys.exit(1)


def delete_project(client: LabelStudio, project_id: int) -> bool:
    """
    Delete a single project
    
    Returns:
        True if deletion successful, False if failed
    """
    try:
        client.projects.delete(id=project_id)
        return True
    except Exception as e:
        print(f"  Error: {e}")
        return False


def delete_projects_by_ids(client: LabelStudio, project_ids: List[int], force: bool = False):
    """Delete projects by IDs"""
    if not project_ids:
        print("No project IDs specified")
        return
    
    print(f"\nPreparing to delete {len(project_ids)} project(s):")
    print(f"Project IDs: {project_ids}")
    
    if not force:
        confirm = input("\nConfirm deletion of these projects? (yes/no): ")
        if confirm.lower() not in ['yes', 'y']:
            print("Deletion cancelled")
            return
    
    success_count = 0
    fail_count = 0
    
    print("\nStarting deletion...")
    for project_id in project_ids:
        print(f"Deleting project {project_id}...", end=" ")
        if delete_project(client, project_id):
            print("✓ Success")
            success_count += 1
        else:
            print("✗ Failed")
            fail_count += 1
    
    print(f"\nDeletion complete: Success {success_count}, Failed {fail_count}")


def delete_projects_by_names(client: LabelStudio, names: List[str], force: bool = False):
    """Delete projects by names"""
    if not names:
        print("No project names specified")
        return
    
    print("\nSearching for matching projects...")
    all_projects = list(client.projects.list())
    
    projects_to_delete = []
    for project in all_projects:
        project_title = get_project_attr(project, 'title', '')
        if project_title in names:
            projects_to_delete.append(project)
    
    if not projects_to_delete:
        print("No matching projects found")
        return
    
    print(f"\nFound {len(projects_to_delete)} matching project(s):")
    for project in projects_to_delete:
        project_id = get_project_attr(project, 'id', 'N/A')
        project_title = get_project_attr(project, 'title', 'Untitled')
        print(f"  - ID: {project_id}, Title: {project_title}")
    
    if not force:
        confirm = input("\nConfirm deletion of these projects? (yes/no): ")
        if confirm.lower() not in ['yes', 'y']:
            print("Deletion cancelled")
            return
    
    project_ids = [get_project_attr(p, 'id') for p in projects_to_delete]
    delete_projects_by_ids(client, project_ids, force=True)


def delete_projects_by_pattern(client: LabelStudio, pattern: str, force: bool = False):
    """Delete projects by name pattern (supports regex)"""
    print(f"\nSearching for projects matching pattern '{pattern}'...")
    filtered_projects = list_projects(client, pattern)
    
    if not filtered_projects:
        print("No matching projects found")
        return
    
    if not force:
        confirm = input(f"\nConfirm deletion of these {len(filtered_projects)} project(s)? (yes/no): ")
        if confirm.lower() not in ['yes', 'y']:
            print("Deletion cancelled")
            return
    
    project_ids = [get_project_attr(p, 'id') for p in filtered_projects]
    delete_projects_by_ids(client, project_ids, force=True)


def delete_projects_by_range(client: LabelStudio, start_id: int, end_id: int, force: bool = False):
    """Delete projects by ID range"""
    project_ids = list(range(start_id, end_id + 1))
    delete_projects_by_ids(client, project_ids, force)


def delete_all_projects(client: LabelStudio, force: bool = False):
    """Delete all projects"""
    print("\nWARNING: About to delete all projects!")
    all_projects = list(client.projects.list())
    
    if not all_projects:
        print("No projects found")
        return
    
    print(f"\nFound {len(all_projects)} project(s)")
    
    if not force:
        print("\nThis will delete ALL projects. This operation cannot be undone!")
        confirm = input("Type 'DELETE ALL' to confirm: ")
        if confirm != 'DELETE ALL':
            print("Deletion cancelled")
            return
    
    project_ids = [get_project_attr(p, 'id') for p in all_projects]
    delete_projects_by_ids(client, project_ids, force=True)


def main():
    parser = argparse.ArgumentParser(
        description='Label Studio Batch Project Deletion Script',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    # Connection parameters
    parser.add_argument('--url', help='Label Studio server URL (default: LABEL_STUDIO_URL env var or http://localhost:8080)')
    parser.add_argument('--api-key', help='API key (default: LABEL_STUDIO_API_KEY env var)')
    
    # Deletion options (mutually exclusive)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--ids', nargs='+', type=int, help='List of project IDs to delete')
    group.add_argument('--names', nargs='+', help='List of project names to delete')
    group.add_argument('--pattern', help='Delete by name pattern (supports regex)')
    group.add_argument('--range', nargs=2, type=int, metavar=('START', 'END'), help='Delete projects in ID range')
    group.add_argument('--all', action='store_true', help='Delete all projects')
    group.add_argument('--list', action='store_true', help='List all projects only')
    
    # Other options
    parser.add_argument('-f', '--force', action='store_true', help='Force deletion without confirmation')
    
    args = parser.parse_args()
    
    # Create client
    client = get_client(args.url, args.api_key)
    
    # Execute operation
    if args.list:
        list_projects(client)
    elif args.ids:
        delete_projects_by_ids(client, args.ids, args.force)
    elif args.names:
        delete_projects_by_names(client, args.names, args.force)
    elif args.pattern:
        delete_projects_by_pattern(client, args.pattern, args.force)
    elif args.range:
        delete_projects_by_range(client, args.range[0], args.range[1], args.force)
    elif args.all:
        delete_all_projects(client, args.force)


if __name__ == '__main__':
    main()
