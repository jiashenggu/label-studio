import React, { useState } from "react";
import { Button, Select } from "@humansignal/ui";
import { IconClose } from "@humansignal/icons";
import { Block, Elem } from "../../utils/bem";
import "./ProjectsFilter.scss";

const DATE_FILTER_OPTIONS = [
  { value: "all", label: "All Time" },
  { value: "day", label: "Last Day" },
  { value: "week", label: "Last Week" },
  { value: "month", label: "Last Month" },
];

export const ProjectsFilter = ({ onFilterChange }) => {
  const [nameFilter, setNameFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("all");
  const [isExpanded, setIsExpanded] = useState(false);

  const handleNameChange = (e) => {
    setNameFilter(e.target.value);
  };

  const handleNameKeyDown = (e) => {
    if (e.key === "Enter") {
      applyFilters(nameFilter, dateFilter);
    }
  };

  const handleDateChange = (val) => {
    console.log("=== DATE CHANGE ===");
    console.log("Value received:", val);
    const value = val || "all";
    console.log("Setting dateFilter to:", value);
    setDateFilter(value);
  };

  const handleApplyFilters = () => {
    applyFilters(nameFilter, dateFilter);
  };

  const applyFilters = (name, date) => {
    const filters = {};
    
    if (name.trim()) {
      filters.title = name.trim();
    }
    
    if (date !== "all") {
      const now = new Date();
      let startDate;
      
      switch (date) {
        case "day":
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = null;
      }
      
      if (startDate) {
        filters.created_after = startDate.toISOString();
      }
    }
    
    console.log("=== APPLYING FILTERS ===");
    console.log("Name:", name);
    console.log("Date range:", date);
    console.log("Filters object:", JSON.stringify(filters, null, 2));
    onFilterChange(filters);
  };

  const clearFilters = () => {
    setNameFilter("");
    setDateFilter("all");
    onFilterChange({});
  };

  const hasActiveFilters = nameFilter.trim() || dateFilter !== "all";

  return (
    <Block name="projects-filter">
      <Elem name="toggle">
        <Button
          size="small"
          look={isExpanded ? "primary" : "default"}
          onClick={() => setIsExpanded(!isExpanded)}
          aria-label="Toggle filters"
        >
          {isExpanded ? "Hide Filters" : "Show Filters"} {hasActiveFilters && `(${[nameFilter.trim() ? 1 : 0, dateFilter !== "all" ? 1 : 0].reduce((a, b) => a + b, 0)})`}
        </Button>
      </Elem>

      {isExpanded && (
        <Elem name="panel">
          <Elem name="content">
            <Elem name="field">
              <Elem name="label">Project Name</Elem>
              <input
                type="text"
                placeholder="Search by project name... (press Enter)"
                value={nameFilter}
                onChange={handleNameChange}
                onKeyDown={handleNameKeyDown}
                className="projects-filter__input"
              />
            </Elem>

            <Elem name="field">
              <Elem name="label">Created Date</Elem>
              <Select
                value={dateFilter}
                options={DATE_FILTER_OPTIONS}
                onChange={handleDateChange}
                placeholder="Select date range"
                className="projects-filter__select"
              />
            </Elem>
          </Elem>

          <Elem name="actions">
            <Button
              size="small"
              look="primary"
              onClick={handleApplyFilters}
            >
              Apply Filters
            </Button>
            {hasActiveFilters && (
              <Button
                size="small"
                look="destructive"
                onClick={clearFilters}
                leading={<IconClose className="!h-3 !w-3" />}
              >
                Clear Filters
              </Button>
            )}
          </Elem>
        </Elem>
      )}
    </Block>
  );
};
