import { useEffect, useState } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { BarChart3, Filter, LayoutDashboard, Settings, Sparkles, FolderKanban, Loader2 } from "lucide-react"
import { getFilters, SavedFilter } from "@/src/services/dbService"
import { useAuth } from "@/src/contexts/AuthContext"

const items = [
  {
    title: "Dashboard",
    url: "#",
    icon: LayoutDashboard,
    isActive: true,
  },
  {
    title: "GSC Analytics",
    url: "#",
    icon: BarChart3,
  },
  {
    title: "AI Content Auditor",
    url: "#",
    icon: Sparkles,
  },
  {
    title: "Projects",
    url: "#",
    icon: FolderKanban,
  },
  {
    title: "Settings",
    url: "#",
    icon: Settings,
  },
]

export function AppSidebar({ selectedSite }: { selectedSite?: string }) {
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [loadingFilters, setLoadingFilters] = useState(false)
  const { user } = useAuth()

  useEffect(() => {
    if (user && selectedSite) {
      setLoadingFilters(true)
      getFilters(selectedSite)
        .then(filters => {
          if (filters) setSavedFilters(filters)
        })
        .catch(err => console.error("Failed to load filters", err))
        .finally(() => setLoadingFilters(false))
    } else {
      setSavedFilters([])
    }
  }, [user, selectedSite])

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2 font-semibold text-lg tracking-tight">
          <div className="bg-primary text-primary-foreground p-1 rounded-md">
            <BarChart3 className="w-5 h-5" />
          </div>
          NextGen SEO
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Analytics</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton render={<a href={item.url} />} isActive={item.isActive}>
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Custom Filters</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {loadingFilters ? (
                <SidebarMenuItem>
                  <div className="flex items-center px-2 py-1.5 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading...
                  </div>
                </SidebarMenuItem>
              ) : savedFilters.length === 0 ? (
                <SidebarMenuItem>
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No saved filters yet
                  </div>
                </SidebarMenuItem>
              ) : (
                savedFilters.map((filter) => (
                  <SidebarMenuItem key={filter.id}>
                    <SidebarMenuButton render={<a href="#" />}>
                      <Filter className="h-4 w-4" />
                      <span className="truncate">{filter.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 text-xs text-muted-foreground">
        &copy; 2026 NextGen SEO
      </SidebarFooter>
    </Sidebar>
  )
}
