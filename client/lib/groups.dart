import 'package:flutter/material.dart';
import 'main.dart' show guarded, textDialog;
import 'store.dart';

const roles = {'owner': '组主', 'editor': '可编辑', 'viewer': '只读'};

class GroupsPane extends StatelessWidget {
  final Workspace store;
  const GroupsPane({super.key, required this.store});
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(26),
    children: [
      Wrap(
        alignment: WrapAlignment.spaceBetween,
        spacing: 20,
        children: [
          const Text(
            '研究小组',
            style: TextStyle(fontSize: 25, fontWeight: FontWeight.w700),
          ),
          FilledButton.icon(
            icon: const Icon(Icons.add),
            label: const Text('创建小组'),
            onPressed: () => guarded(context, () async {
              final name = await textDialog(context, '创建私密小组');
              if (name == null || name.trim().isEmpty) return;
              await store.request('POST', '/groups', {'name': name.trim()});
              await store.sync();
            }),
          ),
        ],
      ),
      const SizedBox(height: 16),
      const Text(
        '切换文献库后导入文献、写笔记或参与讨论，即可与成员共享。',
        style: TextStyle(color: Colors.grey),
      ),
      ...store.groups.map(
        (g) => Card(
          elevation: 0,
          child: ListTile(
            leading: const Icon(Icons.groups_outlined),
            title: Text(g['name']),
            subtitle: Text('权限：${roles[g['role']] ?? g['role']}'),
            onTap: () => store.switchScope('g:${g['id']}'),
            trailing: IconButton(
              tooltip: '成员管理',
              icon: const Icon(Icons.manage_accounts_outlined),
              onPressed: () => showDialog(
                context: context,
                builder: (_) => GroupMembers(store: store, group: g),
              ),
            ),
          ),
        ),
      ),
    ],
  );
}

class GroupMembers extends StatefulWidget {
  final Workspace store;
  final Map<String, dynamic> group;
  const GroupMembers({super.key, required this.store, required this.group});
  @override
  State<GroupMembers> createState() => _GroupMembersState();
}

class _GroupMembersState extends State<GroupMembers> {
  List<Map<String, dynamic>> members = [];
  bool loading = true, busy = false;
  String? error;
  bool get owner => widget.group['role'] == 'owner';
  String get path => '/groups/${widget.group['id']}/members';

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final data = await widget.store.request('GET', path);
      if (mounted) {
        setState(() {
          members = List<Map<String, dynamic>>.from(data['items']);
          loading = false;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          loading = false;
          error = '$e';
        });
      }
    }
  }

  Future<void> mutate(Future<void> Function() operation) async {
    setState(() => busy = true);
    try {
      await operation();
      await load();
    } catch (e) {
      if (mounted) setState(() => error = '$e');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> add() async {
    final email = TextEditingController();
    String role = 'viewer';
    final accepted = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, update) => AlertDialog(
          title: const Text('添加小组成员'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: email,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(labelText: '已注册的邮箱'),
              ),
              DropdownButtonFormField<String>(
                initialValue: role,
                decoration: const InputDecoration(labelText: '权限'),
                items: ['viewer', 'editor']
                    .map(
                      (r) => DropdownMenuItem(value: r, child: Text(roles[r]!)),
                    )
                    .toList(),
                onChanged: (r) => update(() => role = r!),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text('添加'),
            ),
          ],
        ),
      ),
    );
    final value = email.text.trim();
    Future<void>.delayed(const Duration(milliseconds: 400), email.dispose);
    if (accepted == true && value.isNotEmpty && mounted) {
      await mutate(() async {
        await widget.store.request('PUT', path, {'email': value, 'role': role});
      });
    }
  }

  Future<void> remove(Map<String, dynamic> member) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('移除成员'),
        content: Text('移除 ${member['email']} 后，对方将无法继续访问此小组。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('移除'),
          ),
        ],
      ),
    );
    if (yes == true && mounted) {
      await mutate(() async {
        await widget.store.request('DELETE', '$path/${member['id']}');
      });
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('${widget.group['name']} · 成员'),
    content: SizedBox(
      width: 500,
      height: 350,
      child: Column(
        children: [
          if (loading || busy) const LinearProgressIndicator(),
          if (error != null)
            Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          Expanded(
            child: ListView(
              children: members
                  .map(
                    (u) => ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(
                        u['name'] ?? '',
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        u['email'],
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: owner && u['role'] != 'owner'
                          ? Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                DropdownButton<String>(
                                  value: u['role'],
                                  items: ['viewer', 'editor']
                                      .map(
                                        (r) => DropdownMenuItem(
                                          value: r,
                                          child: Text(
                                            roles[r]!,
                                            style: const TextStyle(
                                              fontSize: 12,
                                            ),
                                          ),
                                        ),
                                      )
                                      .toList(),
                                  onChanged: busy
                                      ? null
                                      : (r) => mutate(() async {
                                          await widget.store.request(
                                            'PUT',
                                            path,
                                            {'email': u['email'], 'role': r},
                                          );
                                        }),
                                ),
                                IconButton(
                                  tooltip: '移除 ${u['email']}',
                                  onPressed: busy ? null : () => remove(u),
                                  icon: const Icon(
                                    Icons.person_remove_outlined,
                                    size: 20,
                                  ),
                                ),
                              ],
                            )
                          : Text(roles[u['role']] ?? u['role']),
                    ),
                  )
                  .toList(),
            ),
          ),
        ],
      ),
    ),
    actions: [
      if (owner)
        TextButton.icon(
          onPressed: busy ? null : add,
          icon: const Icon(Icons.person_add_alt),
          label: const Text('添加成员'),
        ),
      TextButton(onPressed: busy ? null : load, child: const Text('刷新')),
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('关闭'),
      ),
    ],
  );
}
