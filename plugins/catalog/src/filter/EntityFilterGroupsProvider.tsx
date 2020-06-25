/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Entity } from '@backstage/catalog-model';
import { useApi } from '@backstage/core';
import React, { useCallback, useState, useRef } from 'react';
import { useAsync } from 'react-use';
import { catalogApiRef } from '../api/types';
import { filterGroupsContext, FilterGroupsContext } from './context';
import {
  EntityFilterFn,
  FilterGroup,
  FilterGroupState,
  FilterGroupStates,
} from './types';

/**
 * Implementation of the shared filter groups state.
 */
export const EntityFilterGroupsProvider = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  const state = useProvideEntityFilters();
  return (
    <filterGroupsContext.Provider value={state}>
      {children}
    </filterGroupsContext.Provider>
  );
};

// The hook that implements the actual context building
function useProvideEntityFilters(): FilterGroupsContext {
  const catalogApi = useApi(catalogApiRef);
  const { value: entities, error } = useAsync(() => catalogApi.getEntities());

  const [filterGroups, setFilterGroups] = useState<{
    [filterGroupId: string]: FilterGroup;
  }>({});
  const [filterGroupStates, setFilterGroupStates] = useState<{
    [filterGroupId: string]: FilterGroupStates;
  }>({});
  const selectedFilterKeys = useRef<Set<string>>(new Set()); // on the format filtergroupid.filterid
  const matchingEntities = useRef<Entity[]>([]);

  const register = useCallback(
    (
      filterGroupId: string,
      filterGroup: FilterGroup,
      initialSelectedFilterIds?: string[],
    ) => {
      setFilterGroups(oldGroups => {
        const newGroups = { ...oldGroups };
        newGroups[filterGroupId] = filterGroup;
        return newGroups;
      });
      if (initialSelectedFilterIds?.length) {
        selectedFilterKeys.current = (() => {
          const newKeys = new Set(selectedFilterKeys.current);
          for (const filterId of initialSelectedFilterIds) {
            newKeys.add(`${filterGroupId}.${filterId}`);
          }
          return newKeys;
        })();
      }
      setFilterGroupStates(
        buildStates(filterGroups, selectedFilterKeys.current, entities, error),
      );
      matchingEntities.current =
        buildMatchingEntities(filterGroups, selectedFilterKeys.current, entities);
    },
    [entities, error, filterGroups, selectedFilterKeys],
  );

  const unregister = useCallback(
    (filterGroupId: string) => {
      setFilterGroups(oldGroups => {
        const copy = { ...oldGroups };
        delete copy[filterGroupId];
        return copy;
      });
      setFilterGroupStates(oldStates => {
        const copy = { ...oldStates };
        delete copy[filterGroupId];
        return copy;
      });
      setFilterGroupStates(
        buildStates(filterGroups, selectedFilterKeys.current, entities, error),
      );
      matchingEntities.current =
        buildMatchingEntities(filterGroups, selectedFilterKeys.current, entities);
    },
    [entities, error, filterGroups, selectedFilterKeys],
  );

  const setGroupSelectedFilters = useCallback(
    (filterGroupId: string, filters: string[]) => {
      selectedFilterKeys.current = (() => {
        const result = new Set<string>();
        for (const key of selectedFilterKeys.current) {
          if (!key.startsWith(`${filterGroupId}.`)) {
            result.add(key);
          }
        }
        for (const key of filters) {
          result.add(`${filterGroupId}.${key}`);
        }
        return result;
      })();
      setFilterGroupStates(
        buildStates(filterGroups, selectedFilterKeys.current, entities, error)
      );
      matchingEntities.current =
        buildMatchingEntities(filterGroups, selectedFilterKeys.current, entities);
    },
    [entities, error, filterGroups, selectedFilterKeys],
  );

  return {
    register,
    unregister,
    setGroupSelectedFilters,
    filterGroupStates.current,
    matchingEntities.current,
  };
}

// Given all filter groups and what filters are actually selected, along with
// the loading state for entities, generate the state of each individual filter
//
function buildStates(
  filterGroups: { [filterGroupId: string]: FilterGroup },
  selectedFilterKeys: Set<string>,
  entities?: Entity[],
  error?: Error,
): { [filterGroupId: string]: FilterGroupStates } {
  // On error - all entries are an error state
  if (error) {
    return Object.fromEntries(
      Object.keys(filterGroups).map(filterGroupId => [
        filterGroupId,
        { type: 'error', error },
      ]),
    );
  }

  // On startup - all entries are a loading state
  if (!entities) {
    return Object.fromEntries(
      Object.keys(filterGroups).map(filterGroupId => [
        filterGroupId,
        { type: 'loading' },
      ]),
    );
  }

  const result: { [filterGroupId: string]: FilterGroupStates } = {};
  for (const [filterGroupId, filterGroup] of Object.entries(filterGroups)) {
    const otherMatchingEntities = buildMatchingEntities(
      filterGroups,
      selectedFilterKeys,
      entities,
      filterGroupId,
    );
    const groupState: FilterGroupState = { filters: {} };
    for (const [filterId, filterFn] of Object.entries(filterGroup.filters)) {
      const isSelected = selectedFilterKeys.has(`${filterGroupId}.${filterId}`);
      const matchCount = otherMatchingEntities.filter(entity =>
        filterFn(entity),
      ).length;
      groupState.filters[filterId] = { isSelected, matchCount };
    }
    result[filterGroupId] = { type: 'ready', state: groupState };
  }

  return result;
}

// Given all filter groups and what filters are actually selected, extract all
// entities that match all those filter groups.
function buildMatchingEntities(
  filterGroups: { [filterGroupId: string]: FilterGroup },
  selectedFilterKeys: Set<string>,
  entities?: Entity[],
  excludeFilterGroupId?: string,
): Entity[] {
  // Build one filter fn per filter group
  const allFilters: EntityFilterFn[] = [];
  for (const [filterGroupId, filterGroup] of Object.entries(filterGroups)) {
    if (excludeFilterGroupId === filterGroupId) {
      continue;
    }

    // Pick out all of the filter functions in the group that are actually
    // selected
    const groupFilters: EntityFilterFn[] = [];
    for (const [filterId, filterFn] of Object.entries(filterGroup.filters)) {
      if (selectedFilterKeys.has(`${filterGroupId}.${filterId}`)) {
        groupFilters.push(filterFn);
      }
    }

    // Need to match any of the selected filters in the group - if there is
    // any at all
    if (groupFilters.length) {
      allFilters.push(entity => groupFilters.some(fn => fn(entity)));
    }
  }

  // All filter groups that had any checked filters need to match. Note that
  // every() always returns true for an empty array.
  return entities?.filter(entity => allFilters.every(fn => fn(entity))) ?? [];
}
