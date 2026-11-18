import { wsBridge } from './ws-bridge';
// the editor's renderer reads window.bridge when its modules load: set it first
(window as any).bridge = wsBridge;
(window as any).__mpiMobile = true;
import('./MobileApp').then(({ mount }) => mount());
