import { useEffect } from 'react';
import { useLocation } from '@tanstack/react-router';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

interface SidebarState {
  isSidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
}

const useSidebarStore = create<SidebarState>((set) => ({
  isSidebarOpen: false,
  openSidebar: () => set({ isSidebarOpen: true }),
  closeSidebar: () => set({ isSidebarOpen: false }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
}));

export function useMobileSidebar() {
  const routeLocation = useLocation();
  const isMobile = useMediaQuery();
  const { isSidebarOpen, closeSidebar, openSidebar, toggleSidebar } = useSidebarStore(
    useShallow((state) => ({
      isSidebarOpen: state.isSidebarOpen,
      closeSidebar: state.closeSidebar,
      openSidebar: state.openSidebar,
      toggleSidebar: state.toggleSidebar,
    })),
  );

  useEffect(() => {
    if (!isMobile) {
      closeSidebar();
    }
  }, [closeSidebar, isMobile]);

  useEffect(() => {
    closeSidebar();
  }, [closeSidebar, routeLocation.pathname]);

  return {
    isSidebarOpen,
    openSidebar,
    closeSidebar,
    toggleSidebar,
  };
}
