# hue-deploy

Simple command line deployment for Hue automations and resources.

Define resources as a collection of YAML files. Reference other resources by name. Deploy.

Hue deploy will take care of:

- Resolving resource ids
- Applying sensible defaults
- Creating missing resources
- Updating outdated resources
- Deleting removed resources (where created by hue-deploy)
- Deploying things in the right order

Resource schema is defined in described in the [deCONZ API docs](https://dresden-elektronik.github.io/deconz-rest-doc/).

## Limitations

- Currently only tested with a Deconz gateway
- Only one collection of resources can be deployed to a given gateway (due to the way resources are tracked to allow update/delete)
- Dependencies across files are not recommended, as ordering is undefined

## Usage

### Installation

- Install node 18 or above
- Install the tool with `npm install -g hue-deploy`

### Quick start

```sh
hue gateway set <YOUR_GATEWAY_IP> <YOUR_GATEWAY_API_KEY>
```

```sh
hue deploy # from current directory
hue deploy --from ~/my-hue-resources # from specific directory
```

```yml
resources:
  - kind: sensor
    name: my-virtual-switch
    type: CLIPGenericFlag

  - kind: rule
    name: my-switch-on
    actions:
      - address: '/sensors/my-virtual-switch/state'
        body:
          flag: true
        method: PUT
    conditions:
      - address: /sensors/my-switch/state/lastupdated
        operator: dx
      - address: /sensors/my-switch/state/buttonevent
        operator: eq
        value: '1002'
      - address: /sensors/my-virtual-switch/state/flag
        operator: eq
        value: 'false'
```

You can also preview changes to be made with:

```sh
hue preview
```

## Contributing

Please raise issues for any bugs/feature requests.

Testing has been through actual use with a good number of resources on a home setup. There are no automated tests yet. Can hopefully add some soonish.

## Release process

Update the version number in `package.json` and:

```sh
yarn build
npm publish
```