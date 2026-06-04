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
import { BarChart3, LayoutDashboard, Settings, Sparkles, Bot, Target, Server, FileSearch, Globe2, PanelsTopLeft } from "lucide-react"
import { useAuth } from "@/src/contexts/AuthContext"
import { isMultiSitePlan } from "@/shared/plans"

const baseItems = [
  { title: "Dashboard", icon: LayoutDashboard },
  { title: "Rank Tracker", icon: Target },
  { title: "Server Logs", icon: Server },
  { title: "Page Indexing", icon: FileSearch },
  { title: "Crawl Inventory", icon: Globe2 },
  { title: "LLM Traffic", icon: Bot },
  { title: "AI Content Auditor", icon: Sparkles },
  { title: "Settings", icon: Settings },
]

export function AppSidebar({ activeMenu = "Dashboard", onMenuSelect }: { selectedSite?: string, activeMenu?: string, onMenuSelect?: (menu: string) => void }) {
  const { userProfile } = useAuth()
  const canUseMultiSite = isMultiSitePlan(userProfile?.tier)
  const items = canUseMultiSite
    ? [baseItems[0], { title: "Sites", icon: PanelsTopLeft }, ...baseItems.slice(1)]
    : baseItems

  return (
    <Sidebar className="w-[240px] border-r border-border bg-background">
      <SidebarHeader className="p-4">
        <div className="p-0">
          <div className="flex items-center gap-3 text-lg font-semibold">
            <div className="rounded-2xl bg-primary p-2.5 text-primary-foreground shadow-[0_10px_22px_rgba(15,61,46,0.16)]">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <div className="text-[18px] font-semibold text-foreground">NextGen SEO</div>
              <div className="text-[12px] font-medium text-muted-foreground">Search intelligence</div>
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="px-3 text-[12px] font-semibold normal-case tracking-normal text-muted-foreground">Analytics</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={activeMenu === item.title}
                    onClick={() => onMenuSelect && onMenuSelect(item.title)}
                    className="interactive-lift h-10 rounded-2xl px-3 data-[active=true]:bg-secondary data-[active=true]:text-secondary-foreground"
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <div className="text-xs text-muted-foreground">
          &copy; 2026 NextGen SEO
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
