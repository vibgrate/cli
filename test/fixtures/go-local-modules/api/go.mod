module example.com/api

go 1.22

require (
	example.com/lib v0.1.0
	example.com/shared v0.2.0
	example.com/extra v0.3.0
	example.com/missing v0.0.0
	github.com/example/remote v1.4.0
)

replace example.com/lib => ../lib
replace example.com/extra => ../extra
replace example.com/missing => ../missing
replace github.com/example/remote => github.com/other/remote v1.5.0
