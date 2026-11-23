import { unsupported } from '../unsupported.ts';

export function createRenderer(): never {
	unsupported('custom renderers');
}
