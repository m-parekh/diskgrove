import { useRef, type KeyboardEvent } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { baseName } from '@shared/paths'
import type { SearchScope } from '@shared/types'
import { SEARCH_SCOPES, scopeInfo } from '@/components/search-scope'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

export const SEARCH_RESULTS_ID = 'search-results'

/** Ribbon search field. The leading button picks the scope, so the field is no wider than a plain one. */
export function SearchBox({ className }: { className?: string }) {
  const {
    meta,
    view,
    tab,
    query,
    setQuery,
    clearSearch,
    runSearch,
    searchScope,
    setSearchScope,
    searchInputRef,
    selectedPath,
    selectedNode,
    rootPath
  } = useScan()
  const disabled = view !== 'scan'
  const scope = scopeInfo(searchScope)
  const ScopeIcon = scope.icon
  const selectedFolder = selectedPath ?? rootPath
  const folderName =
    selectedNode && selectedNode.path === selectedFolder ? selectedNode.name : baseName(selectedFolder ?? '')
  const placeholder = disabled
    ? 'Search files…'
    : searchScope === 'all'
      ? 'Search entire scan…'
      : `Search ${folderName}…`
  const shortcut = meta?.platform === 'darwin' ? '⌘F' : 'Ctrl+F'
  const focusInput = useRef(false)

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && query) {
      // Clears the search without also stopping a running scan.
      event.preventDefault()
      event.stopPropagation()
      clearSearch()
    } else if (event.key === 'ArrowDown' && tab === 'search') {
      const results = document.getElementById(SEARCH_RESULTS_ID)
      if (results) {
        event.preventDefault()
        results.focus()
      }
    }
  }

  return (
    <form
      role="search"
      className={cn('relative w-56 min-w-24 shrink xl:w-64 2xl:w-72', className)}
      onSubmit={(e) => {
        e.preventDefault()
        void runSearch()
      }}
    >
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Search in: ${scope.label}`}
                className="absolute inset-y-0.5 left-0.5 z-10 flex w-6 items-center justify-center gap-0.5 rounded-[5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-accent aria-expanded:text-foreground lg:w-9"
              >
                <ScopeIcon key={searchScope} className="size-3.5 shrink-0 animate-icon-pop" />
                <ChevronDown className="hidden size-3 shrink-0 opacity-70 lg:block" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Search in: {scope.label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          collisionPadding={8}
          className="w-72 max-w-[calc(100vw-1rem)]"
          onCloseAutoFocus={(event) => {
            if (!focusInput.current) return
            focusInput.current = false
            event.preventDefault()
            searchInputRef.current?.focus()
          }}
        >
          <DropdownMenuLabel>Search in</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={searchScope}
            onValueChange={(value) => {
              focusInput.current = true
              setSearchScope(value as SearchScope)
              if (query.trim()) void runSearch()
            }}
          >
            {SEARCH_SCOPES.map(({ id, label, icon: Icon }) => {
              const folder = id === 'folder' ? selectedFolder : rootPath
              return (
                <DropdownMenuRadioItem key={id} value={id} className="items-start">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span>{label}</span>
                    {folder ? (
                      <span className="truncate-start text-xs text-muted-foreground" title={folder}>
                        <bdi>{folder}</bdi>
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
            Text matches anywhere in a name. With <kbd className="font-mono">*</kbd> or{' '}
            <kbd className="font-mono">?</kbd> the whole name must match, as in <span className="font-mono">*.mp4</span>
            . {shortcut} jumps here.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <Input
        ref={searchInputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onClick={() => {
          // Clicking back into a kept query returns to its results.
          if (tab !== 'search' && query.trim()) void runSearch()
        }}
        placeholder={placeholder}
        // Matches the ribbon's small buttons; the scope and clear buttons sit inside the border.
        className={cn(
          'peer h-7 w-full pl-8 pr-8 text-xs focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 lg:pl-11',
          !query && !disabled && 'lg:pr-14'
        )}
        disabled={disabled}
        aria-label="Search files"
        aria-keyshortcuts={meta?.platform === 'darwin' ? 'Meta+F' : 'Control+F'}
        spellCheck={false}
        autoComplete="off"
      />
      {!query && !disabled ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-1.5 my-auto hidden h-4 items-center rounded border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground lg:flex peer-focus:hidden"
        >
          {shortcut}
        </kbd>
      ) : null}
      {query ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0.5 top-0.5 h-6 w-6 rounded-[5px] text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
          onClick={() => {
            clearSearch()
            searchInputRef.current?.focus()
          }}
          aria-label="Clear search"
          disabled={disabled}
        >
          <X className="size-3.5 animate-icon-pop" />
        </Button>
      ) : null}
    </form>
  )
}
