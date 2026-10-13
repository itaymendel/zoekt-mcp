package registry

type Registry struct{}

func (r *Registry) LookupEntry(name string) error {
	return nil
}

func LookupAll(names []string) int {
	return len(names)
}
