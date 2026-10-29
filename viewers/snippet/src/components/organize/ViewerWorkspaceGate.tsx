import { h, ComponentChildren, Fragment } from 'preact';

import { useOrganizeContext } from './OrganizeContext';

export function ViewerWorkspaceGate({ children }: { children: ComponentChildren }) {
  const { isOrganizeMode } = useOrganizeContext();
  if (isOrganizeMode) return null;
  return <Fragment>{children}</Fragment>;
}
