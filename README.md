# Server monitoring service

This is to monitor a server using Prometheus, Grafana and others services.

## Docs for ssl for saas by cloudflare:

- [Nginx Multi-Domain SSL Setup](https://medium.com/@nurulislamrimon/unlock-hassle-free-saas-ssl-cloudflare-docker-nginx-made-simple-859d3fd8e9a8)

Use Grafana:

```

    docker run -d --name=grafana -p 3000:3000 grafana/grafana

```

default credentials:

```
        admin
        admin
```

### add new dashboard form grafana's panel

[visit grafana's dashboard](https://grafana.com/grafana/dashboards/) to get the best dashboard

- select `Prometheus` as data source

- in the `Query` field, use the following query to monitor request time:

### add http request monitoring service

- in the `Metrics` field, use `http_request_duration_seconds_sum` and `http_request_duration_seconds_count` to monitor request time
- set the `Legend` field to `{{method}} {{route}} {{status_code}}` to differentiate metrics by method, route, and status code
- set the `Format` field to `Table` for better visualization
- set the `Visualization` to `Heatmap` to see the request time distribution
- set the `Y-Axis` to `ms` (milliseconds) for better readability
- set the `Unit` to `ms` (milliseconds) for better readability
- set the `Buckets` to `1,50,100,200,400,500,800,1000,2000` to define the time intervals for the heatmap
- set the `Display` options as per your preference for better visualization
- save the dashboard with a meaningful name for future reference.

Use Grafana Loki to collect logs:

```

    docker run -d --name=loki -p 3100:3100 grafana/loki

```
