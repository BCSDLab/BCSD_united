declare module '*.scss' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.svg' {
  import type { FunctionComponent, SVGProps } from 'react';
  const component: FunctionComponent<SVGProps<SVGSVGElement>>;
  export default component;
}

declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*.png' {
  const url: string;
  export default url;
}
declare module '*.jpg' {
  const url: string;
  export default url;
}
declare module '*.jpeg' {
  const url: string;
  export default url;
}
declare module '*.gif' {
  const url: string;
  export default url;
}
declare module '*.webp' {
  const url: string;
  export default url;
}
declare module '*.avif' {
  const url: string;
  export default url;
}
