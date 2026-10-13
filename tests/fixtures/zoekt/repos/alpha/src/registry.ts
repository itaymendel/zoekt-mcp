export class Registry {
	lookupEntry(name: string): boolean {
		return name.length > 0;
	}
}

export function lookupAll(names: string[]): number {
	return names.length;
}
