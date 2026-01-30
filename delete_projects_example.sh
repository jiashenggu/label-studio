#!/bin/bash
# Label Studio Batch Project Deletion Example Script

# Set environment variables
export LABEL_STUDIO_URL="http://localhost:8111"
export LABEL_STUDIO_API_KEY="your-api-key-here"

# Method 1: List all projects (no deletion)
echo "=== List all projects ==="
python delete_projects.py --list

# Method 2: Delete projects by specific IDs
echo -e "\n=== Delete projects by IDs ==="
# python delete_projects.py --ids 1 2 3

# Method 3: Delete projects by names
echo -e "\n=== Delete projects by names ==="
# python delete_projects.py --names "Test Project 1" "Test Project 2"

# Method 4: Delete by name pattern (supports regex)
echo -e "\n=== Delete by pattern ==="
# python delete_projects.py --pattern "test.*"  # Delete all projects containing 'test'
# python delete_projects.py --pattern "^temp"   # Delete all projects starting with 'temp'

# Method 5: Delete projects in ID range
echo -e "\n=== Delete by ID range ==="
# python delete_projects.py --range 1 10

# Method 6: Delete all projects (requires typing 'DELETE ALL' to confirm)
echo -e "\n=== Delete all projects ==="
# python delete_projects.py --all

# Use --force to skip confirmation (dangerous!)
# python delete_projects.py --ids 1 2 3 --force
