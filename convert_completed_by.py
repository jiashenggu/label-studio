#!/usr/bin/env python3
"""
Script to convert all 'completed_by' fields to 1 in annotation JSON data.
"""

import json
import sys
from pathlib import Path


def convert_completed_by(data, new_value=1):
    """
    Recursively convert all 'completed_by' fields in the data structure to new_value.
    
    Args:
        data: JSON data (dict, list, or primitive)
        new_value: Value to set for completed_by (default: 1)
    
    Returns:
        Modified data with completed_by fields updated
    """
    if isinstance(data, dict):
        for key, value in data.items():
            if key == 'completed_by':
                data[key] = new_value
            else:
                convert_completed_by(value, new_value)
    elif isinstance(data, list):
        for item in data:
            convert_completed_by(item, new_value)
    
    return data


def main():
    """Main function to process annotation data."""
    # Check if input file is provided
    if len(sys.argv) < 2:
        print("Usage: python convert_completed_by.py <input_file> [output_file]")
        print("  If output_file is not provided, will use input_file with '_converted' suffix")
        sys.exit(1)
    
    input_file = Path(sys.argv[1])
    
    # Determine output file
    if len(sys.argv) >= 3:
        output_file = Path(sys.argv[2])
    else:
        output_file = input_file.parent / f"{input_file.stem}_converted{input_file.suffix}"
    
    # Check if input file exists
    if not input_file.exists():
        print(f"Error: Input file '{input_file}' not found!")
        sys.exit(1)
    
    # Read the JSON data
    print(f"Reading from: {input_file}")
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse JSON file: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Error reading file: {e}")
        sys.exit(1)
    
    # Count completed_by fields before conversion
    count_before = count_completed_by_fields(data)
    print(f"Found {count_before} 'completed_by' fields")
    
    # Convert completed_by fields to 1
    convert_completed_by(data, new_value=1)
    
    # Write the modified data
    print(f"Writing to: {output_file}")
    try:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Error writing file: {e}")
        sys.exit(1)
    
    print(f"✓ Successfully converted all 'completed_by' fields to 1")
    print(f"✓ Output saved to: {output_file}")


def count_completed_by_fields(data):
    """Count the number of 'completed_by' fields in the data structure."""
    count = 0
    
    if isinstance(data, dict):
        for key, value in data.items():
            if key == 'completed_by':
                count += 1
            else:
                count += count_completed_by_fields(value)
    elif isinstance(data, list):
        for item in data:
            count += count_completed_by_fields(item)
    
    return count


if __name__ == '__main__':
    main()

